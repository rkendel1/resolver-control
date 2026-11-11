/**
 * The thesis, end to end, against the real Resolver: a running consumer resolves ref://prod/ai/default;
 * an engineer proposes a different model; it is validated, approved by a person, executed through
 * Resolver, verified, and recorded. The consumer, never restarted, resolves the new model.
 * Then the same for something that is not a model: the search provider endpoint.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { ResolverClient } from "@appport/resolver-client";
import { createTestApp } from "@feltdb/feltkit/testing";
import { api } from "../feltkit/_generated/api.js";
import { engineFor, seedResolver, settle, startResolver } from "./helpers.js";

test("model and endpoint changes: proposed, approved, executed through Resolver, verified; a running consumer follows", async () => {
  const resolver = await startResolver();
  const t = await createTestApp();
  // The consuming application: connected once, live, never restarted.
  const consumer = await ResolverClient.connect({ url: resolver.url, apiKey: resolver.consumerKey });
  const engine = engineFor(t, resolver);
  try {
    await seedResolver(resolver.admin);
    const ada = t.as("ada");
    await ada.mutation(api.settings.set, { resolverUrl: resolver.url, namespaces: ["prod", "staging"] });
    await ada.mutation(api.demo.seed, {});
    await settle(engine, 1);

    // Observed, and joined with declared governance metadata.
    const inventory = await ada.query(api.catalog.inventory, {});
    const model = inventory.find((r) => r.ref === "ref://prod/ai/default")!;
    assert.equal(model.governance, "governed");
    assert.equal(model.revision, 1);
    assert.match(model.summary!, /openai\/gpt-4o/);
    assert.equal(model.consumers, 2);
    const key = inventory.find((r) => r.ref === "ref://prod/llm/primary-key")!;
    assert.equal(key.kind, "secret");
    assert.doesNotMatch(JSON.stringify(inventory), /sk-test-/, "secret material never reaches the application");

    const before = await consumer.model("ref://prod/ai/default");
    assert.equal(before.model, "gpt-4o");
    assert.equal(before.revision, 1);

    // Grace proposes; nothing changes in Resolver.
    const grace = t.as("grace");
    const proposal = await grace.mutation(api.changes.proposeRetarget, {
      ref: "ref://prod/ai/default",
      basedOnRevision: 1,
      binding: { value: { provider: "anthropic", model: "claude-sonnet-5-5", credential: "ref://prod/llm/primary-key" } },
      reason: "Cost and quality review: move default chat to Claude",
    });
    assert.equal(proposal.status, "proposed");
    assert.equal(proposal.impact.protected, true);
    assert.equal(proposal.impact.declaredConsumers.length, 2);
    assert.ok(proposal.impact.differences.some((d) => d.includes("Introduces provider anthropic")));
    assert.equal(proposal.impact.requiredApprovals, 1);

    await settle(engine, 1);
    let state = await ada.query(api.changes.get, { id: proposal.id });
    assert.equal(state.change.status, "ready", JSON.stringify(state.change.validation));
    assert.ok(state.change.validation!.checks.some((c) => c.id === "binding" && c.outcome === "pass"));
    assert.ok(state.change.validation!.checks.some((c) => c.id === "credential:ref://prod/llm/primary-key" && c.outcome === "pass"));
    assert.ok(state.change.validation!.checks.some((c) => c.id === "catalog" && c.outcome === "deferred"));
    assert.equal((await consumer.model("ref://prod/ai/default")).model, "gpt-4o", "validation changes nothing");

    // Authority: the proposer cannot approve; a non-protected approver cannot approve prod; an agent cannot approve.
    await assert.rejects(grace.mutation(api.changes.approve, { id: proposal.id }), (e: { code: string }) => e.code === "FORBIDDEN");
    await assert.rejects(t.as("barbara").mutation(api.changes.approve, { id: proposal.id }), /protected/);
    await assert.rejects(t.as("ops-agent").mutation(api.changes.approve, { id: proposal.id }), (e: { code: string }) => e.code === "FORBIDDEN");
    await settle(engine, 1);
    assert.equal((await ada.query(api.changes.get, { id: proposal.id })).change.status, "ready", "an unapproved change never executes");

    const approved = await t.as("linus").mutation(api.changes.approve, { id: proposal.id, note: "Benchmarks reviewed" });
    assert.equal(approved.status, "approved");

    await settle(engine, 1);
    state = await ada.query(api.changes.get, { id: proposal.id });
    assert.equal(state.change.status, "verified", JSON.stringify(state.change.execution));
    assert.equal(state.change.execution!.resolverRevision, 2);
    assert.equal(state.change.verification!.correlated, true);
    assert.equal(state.change.verification!.bindingMatches, true);
    assert.equal(state.change.verification!.actor, `api_key:${resolver.executorPrincipal}`, "Resolver attributes the write to the executor key");

    // Resolver's own history names the change.
    const history = (await resolver.admin.history("ref://prod/ai/default")).entries;
    // Resolver returns history oldest first.
    assert.match(history.at(-1)!.reason!, new RegExp(`CHG-${proposal.number} ${proposal.id}`));

    // The consumer, same process, same client: the new model, with no restart or redeploy.
    const deadline = Date.now() + 5000;
    let after = await consumer.model("ref://prod/ai/default");
    while (after.revision !== 2 && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 50));
      after = await consumer.model("ref://prod/ai/default");
    }
    assert.equal(after.provider, "anthropic");
    assert.equal(after.model, "claude-sonnet-5-5");
    assert.equal(after.revision, 2);

    // Not a model: the search provider. Unprotected? prod is protected; Linus approves.
    await settle(engine, 1);
    const search = await grace.mutation(api.changes.proposeRetarget, {
      ref: "ref://prod/search",
      basedOnRevision: 1,
      binding: { strategy: "failover", targets: [{ value: { url: "https://search-b.example.com" }, label: "provider-b" }, { value: { url: "https://search-a.example.com" }, label: "provider-a" }] },
      reason: "Move search to provider B with A as failover",
    });
    assert.ok(search.impact.differences.some((d) => d.includes("search-b.example.com")));
    assert.match(search.impact.fallback, /failover across 2/);
    await settle(engine, 1);
    await t.as("linus").mutation(api.changes.approve, { id: search.id });
    await settle(engine, 1);
    const searchState = await ada.query(api.changes.get, { id: search.id });
    assert.equal(searchState.change.status, "verified");
    const endpoint = await consumer.resolve("ref://prod/search");
    assert.equal((endpoint.selected.value as { url: string }).url, "https://search-b.example.com/");
    assert.equal(endpoint.strategy, "failover");

    // The audit trail tells the whole story, with request ids.
    const trail = (await ada.query(api.activity.list, { ref: "ref://prod/ai/default" })).map((e) => e.type).reverse();
    for (const type of ["change.proposed", "change.validated", "change.approval_recorded", "change.approved", "change.execution_started", "change.verified"]) assert.ok(trail.includes(type), `${type} in ${trail.join(", ")}`);
    assert.ok(!trail.includes("resolver.change.out_of_band"), "our own writes are not reported as out-of-band");

    // Revert: a new change, its own approval, Resolver's rollback, history kept.
    await settle(engine, 1);
    const revert = await grace.mutation(api.changes.proposeRevert, { id: proposal.id, reason: "Latency regression in support-assistant" });
    assert.equal(revert.operation, "rollback");
    assert.equal(revert.toRevision, 1);
    await settle(engine, 1);
    await ada.mutation(api.changes.approve, { id: revert.id });
    await settle(engine, 1);
    const reverted = await ada.query(api.changes.get, { id: revert.id });
    assert.equal(reverted.change.status, "verified", JSON.stringify(reverted.change));
    assert.equal(reverted.change.execution!.resolverRevision, 3);
    const entries = (await resolver.admin.history("ref://prod/ai/default")).entries;
    assert.deepEqual(entries.map((e) => e.revision), [1, 2, 3], "history is never erased");
    assert.equal(entries.at(-1)!.restoredFrom, 1);
    let back = await consumer.model("ref://prod/ai/default");
    const until = Date.now() + 5000;
    while (back.revision !== 3 && Date.now() < until) {
      await new Promise((r) => setTimeout(r, 50));
      back = await consumer.model("ref://prod/ai/default");
    }
    assert.equal(back.model, "gpt-4o");
  } finally {
    await engine.close();
    await consumer.close();
    await t.close();
    await resolver.close();
  }
});
