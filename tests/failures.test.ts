/**
 * Failure, concurrency, authority and recovery, against the real Resolver. Faults that need a
 * crash or a lost answer are injected by wrapping the real client; Resolver itself is never faked.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { ResolverClient, ResolverClientError } from "@appport/resolver-client";
import { createTestApp, type TestApp } from "@feltdb/feltkit/testing";
import { api } from "../feltkit/_generated/api.js";
import type { Connect } from "../component/engine.js";
import { engineFor, seedResolver, settle, startResolver, type RealResolver } from "./helpers.js";

async function setup(options: Parameters<typeof startResolver>[0] = {}) {
  const resolver = await startResolver(options);
  const t = await createTestApp();
  await seedResolver(resolver.admin);
  await t.as("ada").mutation(api.settings.set, { resolverUrl: resolver.url, namespaces: ["prod", "staging"] });
  await t.as("ada").mutation(api.demo.seed, {});
  return { resolver, t };
}

async function teardown(resolver: RealResolver, t: TestApp, ...engines: Array<{ close(): Promise<void> }>) {
  for (const e of engines) await e.close();
  await t.close();
  await resolver.close();
}

const searchB = { value: { url: "https://search-b.example.com" } };

async function proposeAndApprove(t: TestApp, engine: Parameters<typeof settle>[0], binding: unknown = searchB, ref = "ref://prod/search", basedOnRevision = 1) {
  const change = await t.as("grace").mutation(api.changes.proposeRetarget, { ref, basedOnRevision, binding, reason: "Switch search provider" });
  await settle(engine, 1);
  const ready = await t.as("ada").query(api.changes.get, { id: change.id });
  assert.equal(ready.change.status, "ready", JSON.stringify(ready.change.validation));
  await t.as("linus").mutation(api.changes.approve, { id: change.id });
  return change;
}

test("a change made directly in Resolver after approval: the conditional write is refused, the change is superseded, the out-of-band write is recorded", async () => {
  const { resolver, t } = await setup();
  const engine = engineFor(t, resolver);
  try {
    await settle(engine, 1);
    const change = await proposeAndApprove(t, engine);
    // Someone uses Resolver's CLI directly between approval and execution.
    await resolver.admin.put({ ref: "ref://prod/search", binding: { value: { url: "https://search-c.example.com" } }, expectedRevision: 1, reason: "hotfix from the CLI" });
    await settle(engine, 1);
    const after = await t.as("ada").query(api.changes.get, { id: change.id });
    assert.equal(after.change.status, "superseded", JSON.stringify(after.change.execution));
    assert.match(after.change.execution!.note!, /moved from revision 1 to 2/);
    // Resolver kept the operator's value; ours was never written.
    const current = await resolver.admin.resolve("ref://prod/search");
    assert.equal((current.selected.value as { url: string }).url, "https://search-c.example.com/");
    const trail = await t.as("ada").query(api.activity.list, { ref: "ref://prod/search" });
    const outside = trail.find((e) => e.type === "resolver.change.out_of_band");
    assert.ok(outside, "the direct write is on the audit trail");
    assert.equal((outside!.data as { reason: string }).reason, "hotfix from the CLI");
    const findings = await t.as("ada").query(api.insights.findings, {});
    assert.ok(findings.some((f) => f.id === "out-of-band:ref://prod/search:2"));
  } finally {
    await teardown(resolver, t, engine);
  }
});

test("a proposal awaiting approval goes stale when the reference moves, and cannot be approved", async () => {
  const { resolver, t } = await setup();
  const engine = engineFor(t, resolver);
  try {
    await settle(engine, 1);
    const change = await t.as("grace").mutation(api.changes.proposeRetarget, { ref: "ref://prod/search", basedOnRevision: 1, binding: searchB, reason: "Switch search" });
    await settle(engine, 1);
    await resolver.admin.put({ ref: "ref://prod/search", binding: { value: { url: "https://search-c.example.com" } }, expectedRevision: 1, reason: "direct" });
    // Before the next sync, the observation still says r1: approval goes through policy checks...
    await settle(engine, 1); // ...after it, the engine supersedes the stale proposal.
    const after = await t.as("ada").query(api.changes.get, { id: change.id });
    assert.equal(after.change.status, "superseded");
    await assert.rejects(t.as("linus").mutation(api.changes.approve, { id: change.id }), /superseded/);
  } finally {
    await teardown(resolver, t, engine);
  }
});

test("Resolver's grants are the boundary: an executor key without write on prod fails the change and leaves the reference unchanged", async () => {
  const { resolver, t } = await setup({ executorWrite: ["ref://staging/*"] });
  const engine = engineFor(t, resolver);
  try {
    await settle(engine, 1);
    const change = await proposeAndApprove(t, engine);
    await settle(engine, 1);
    const after = await t.as("ada").query(api.changes.get, { id: change.id });
    assert.equal(after.change.status, "failed");
    assert.equal(after.change.execution!.error!.code, "FORBIDDEN");
    assert.equal((await resolver.admin.resolve("ref://prod/search")).revision, 1, "unchanged");
  } finally {
    await teardown(resolver, t, engine);
  }
});

test("validation refuses what Resolver would refuse, and what crosses environments", async () => {
  const { resolver, t } = await setup();
  const engine = engineFor(t, resolver);
  try {
    await settle(engine, 1);
    const grace = t.as("grace");
    const leaked = await grace.mutation(api.changes.proposeRetarget, { ref: "ref://prod/ai/default", basedOnRevision: 1, binding: { value: { provider: "openai", model: "gpt-4o", options: { apiKey: "sk-nope" } } }, reason: "inline key" });
    await settle(engine, 1);
    let state = await t.as("ada").query(api.changes.get, { id: leaked.id });
    assert.equal(state.change.status, "invalid");
    assert.match(state.change.validation!.checks.find((c) => c.id === "binding")!.detail, /looks like a credential/);
    await grace.mutation(api.changes.cancel, { id: leaked.id });

    const crossing = await grace.mutation(api.changes.proposeRetarget, { ref: "ref://prod/ai/default", basedOnRevision: 1, binding: { value: { provider: "openai", model: "gpt-4o", credential: "ref://staging/llm/primary-key" } }, reason: "staging key in prod" });
    assert.ok(crossing.impact.warnings.some((w) => w.includes("outside prod")));
    await settle(engine, 1);
    state = await t.as("ada").query(api.changes.get, { id: crossing.id });
    assert.equal(state.change.status, "invalid");
    assert.equal(state.change.validation!.checks.find((c) => c.id === "environment")!.outcome, "fail");
    await grace.mutation(api.changes.cancel, { id: crossing.id });

    // The app never handles secret material.
    await assert.rejects(grace.mutation(api.changes.proposeRetarget, { ref: "ref://prod/llm/primary-key", basedOnRevision: 1, binding: { value: "x" }, reason: "rotate" }), /never handled/);
    // Proposals must be based on what was inspected.
    await assert.rejects(grace.mutation(api.changes.proposeRetarget, { ref: "ref://prod/search", basedOnRevision: 7, binding: searchB, reason: "blind" }), /revision 1/);
    // A viewer cannot propose; one open change per reference.
    await assert.rejects(t.as("katherine").mutation(api.changes.proposeRetarget, { ref: "ref://prod/search", basedOnRevision: 1, binding: searchB, reason: "x" }), (e: { code: string }) => e.code === "FORBIDDEN");
    await grace.mutation(api.changes.proposeRetarget, { ref: "ref://prod/search", basedOnRevision: 1, binding: searchB, reason: "first" });
    await assert.rejects(grace.mutation(api.changes.proposeRetarget, { ref: "ref://prod/search", basedOnRevision: 1, binding: searchB, reason: "second" }), /already open/);
  } finally {
    await teardown(resolver, t, engine);
  }
});

/** A connect that hands out the real client, but loses Resolver's answer to the first write (the write itself happens, or not). */
function losingAnswer(mode: "after-write" | "before-write"): { connect: Connect; lost: () => number } {
  let lost = 0;
  const connect: Connect = async (o) => {
    const client = await ResolverClient.connect({ ...o, timeoutMs: 5000, maxStaleSeconds: 0 });
    const put = client.put.bind(client);
    client.put = async (input) => {
      if (lost === 0) {
        lost += 1;
        if (mode === "after-write") await put(input);
        throw new ResolverClientError("UNAVAILABLE", undefined, "socket hang up");
      }
      return put(input);
    };
    return client;
  };
  return { connect, lost: () => lost };
}

test("the write happened but its answer was lost: unknown, then reconciled from Resolver's history by the change's tag, verified", async () => {
  const { resolver, t } = await setup();
  const fault = losingAnswer("after-write");
  const engine = engineFor(t, resolver, { connect: fault.connect });
  try {
    await settle(engine, 1);
    const change = await proposeAndApprove(t, engine);
    await engine.tick();
    let state = await t.as("ada").query(api.changes.get, { id: change.id });
    assert.equal(fault.lost(), 1);
    assert.equal(state.change.status, "unknown", "never guessed");
    await engine.tick();
    state = await t.as("ada").query(api.changes.get, { id: change.id });
    assert.equal(state.change.status, "verified", JSON.stringify(state.change.execution));
    assert.equal(state.change.execution!.attempt, 2);
    assert.match(state.change.execution!.note!, /applied as revision 2/);
    assert.equal((await resolver.admin.history("ref://prod/search")).entries.length, 2, "written exactly once");
  } finally {
    await teardown(resolver, t, engine);
  }
});

test("the write never happened: unknown, reconciled as not applied, executed again under the same approval, verified once", async () => {
  const { resolver, t } = await setup();
  const fault = losingAnswer("before-write");
  const engine = engineFor(t, resolver, { connect: fault.connect });
  try {
    await settle(engine, 1);
    const change = await proposeAndApprove(t, engine);
    await engine.tick(); // lost
    await engine.tick(); // reconciled: requeued
    let state = await t.as("ada").query(api.changes.get, { id: change.id });
    assert.equal(state.change.status, "approved");
    await engine.tick(); // executed
    state = await t.as("ada").query(api.changes.get, { id: change.id });
    assert.equal(state.change.status, "verified");
    assert.equal(state.change.execution!.attempt, 3);
    const types = (await t.as("ada").query(api.activity.list, { subjectId: change.id })).map((e) => e.type);
    for (const type of ["change.unknown", "change.reconciliation_started", "change.requeued", "change.verified"]) assert.ok(types.includes(type), type);
  } finally {
    await teardown(resolver, t, engine);
  }
});

test("policy: frozen environments hold approved changes; critical dependencies need two different people; state survives a restart", async () => {
  const { resolver, t } = await setup();
  let engine = engineFor(t, resolver);
  try {
    await settle(engine, 1);
    const ada = t.as("ada");
    const change = await proposeAndApprove(t, engine);
    await ada.mutation(api.policies.freeze, { environment: "prod", frozen: true, reason: "Black Friday" });
    await settle(engine, 2);
    assert.equal((await ada.query(api.changes.get, { id: change.id })).change.status, "approved", "held while frozen");
    assert.equal((await resolver.admin.resolve("ref://prod/search")).revision, 1);
    await assert.rejects(t.as("linus").mutation(api.changes.approve, { id: change.id }), /approved; only/);

    // Restart the application: approvals, policy and the change are durable.
    await engine.close();
    await t.restart();
    engine = engineFor(t, resolver);
    await ada.mutation(api.policies.freeze, { environment: "prod", frozen: false });
    await settle(engine, 1);
    assert.equal((await ada.query(api.changes.get, { id: change.id })).change.status, "verified");

    // Critical: the provider key's model needs two distinct approvers.
    await ada.mutation(api.catalog.register, { ref: "ref://prod/ai/default", title: "Default chat model", category: "ai", criticality: "critical", changeClass: "runtime", owner: "platform-ai" });
    const model = await t.as("grace").mutation(api.changes.proposeRetarget, { ref: "ref://prod/ai/default", basedOnRevision: 1, binding: { value: { provider: "anthropic", model: "claude-sonnet-5-5", credential: "ref://prod/llm/primary-key" } }, reason: "Switch default model" });
    assert.equal(model.impact.requiredApprovals, 2);
    await settle(engine, 1);
    assert.equal((await t.as("linus").mutation(api.changes.approve, { id: model.id })).status, "ready");
    await assert.rejects(t.as("linus").mutation(api.changes.approve, { id: model.id }), /already approved/);
    await settle(engine, 1);
    assert.equal((await ada.query(api.changes.get, { id: model.id })).change.status, "ready", "one approval is not enough");
    assert.equal((await ada.mutation(api.changes.approve, { id: model.id })).status, "approved");
    await settle(engine, 1);
    assert.equal((await ada.query(api.changes.get, { id: model.id })).change.status, "verified");
  } finally {
    await teardown(resolver, t, engine);
  }
});

test("promotion: staging's binding proposed for prod; secrets stay out of every record", async () => {
  const { resolver, t } = await setup();
  const engine = engineFor(t, resolver);
  try {
    await settle(engine, 1);
    const promotion = await t.as("grace").mutation(api.changes.proposePromotion, { from: "ref://staging/search", toEnvironment: "prod", reason: "Provider B passed in staging" });
    assert.equal(promotion.ref, "ref://prod/search");
    assert.deepEqual(promotion.promotedFrom, { ref: "ref://staging/search", revision: 1 });
    await settle(engine, 1);
    await t.as("linus").mutation(api.changes.approve, { id: promotion.id });
    await settle(engine, 1);
    assert.equal((await t.as("ada").query(api.changes.get, { id: promotion.id })).change.status, "verified");
    const compare = await t.as("ada").query(api.catalog.compare, { environments: ["staging", "prod"] });
    assert.equal(compare.find((r) => r.path === "search")!.differs, false);

    // No record anywhere holds the provider key's material.
    const material = await resolver.admin.secret("ref://prod/llm/primary-key");
    const everything = JSON.stringify([
      await t.as("ada").query(api.catalog.inventory, {}),
      await t.as("ada").query(api.catalog.detail, { ref: "ref://prod/llm/primary-key" }),
      await t.as("ada").query(api.catalog.detail, { ref: "ref://prod/ai/default" }),
      await t.as("ada").query(api.changes.list, {}),
      await t.as("ada").query(api.activity.list, {}),
      await t.as("ada").query(api.insights.findings, {}),
    ]);
    assert.ok(material.length > 10);
    assert.ok(!everything.includes(material), "secret material is in no record");
  } finally {
    await teardown(resolver, t, engine);
  }
});

test("separation of duties holds even for a person allowed to both propose and approve", async () => {
  const { resolver, t } = await setup();
  const engine = engineFor(t, resolver);
  try {
    await settle(engine, 1);
    const pat = t.as({ id: "pat", type: "user", roles: ["engineer", "prod_approver"] });
    const change = await pat.mutation(api.changes.proposeRetarget, { ref: "ref://prod/search", basedOnRevision: 1, binding: searchB, reason: "Switch search" });
    await settle(engine, 1);
    await assert.rejects(pat.mutation(api.changes.approve, { id: change.id }), /proposer of a change may not approve it/);
    // A service principal with the permission is still not a person.
    const service = t.as({ id: "ci-bot", type: "service", roles: ["prod_approver"] });
    await assert.rejects(service.mutation(api.changes.approve, { id: change.id }), /Only a person/);
    await settle(engine, 1);
    assert.equal((await t.as("ada").query(api.changes.get, { id: change.id })).change.status, "ready");
  } finally {
    await teardown(resolver, t, engine);
  }
});

test("with no approval signer configured, under a Resolver mutation policy an approved change fails safely and the reference is unchanged", async (t) => {
  const { resolver, t: app } = await setup();
  const runtime = (resolver as unknown as { runtime?: { resolver: { setPolicy?: unknown } } }).runtime;
  if (!runtime || typeof runtime.resolver.setPolicy !== "function") {
    await teardown(resolver, app);
    t.skip("the installed Resolver has no mutation policies (needs @appport/resolver 0.4.0; set RESOLVER_SERVICE_FROM to a build)");
    return;
  }
  const engine = engineFor(app, resolver);
  try {
    const operator = (runtime as unknown as { operator(tenant: string): unknown }).operator("acme");
    await (runtime.resolver as unknown as { setPolicy(p: unknown, i: unknown): Promise<unknown> }).setPolicy(operator, { pattern: "ref://prod/*", operations: ["put", "rollback", "revoke"], issuers: ["resolver-control"], reason: "prod is governed" });
    await settle(engine, 1);
    const change = await proposeAndApprove(app, engine);
    await settle(engine, 1);
    const after = await app.as("ada").query(api.changes.get, { id: change.id });
    assert.equal(after.change.status, "failed");
    assert.equal(after.change.execution!.error!.reason, "resolver.authorization-required");
    assert.equal((await resolver.admin.resolve("ref://prod/search")).revision, 1, "unchanged");
  } finally {
    await teardown(resolver, app, engine);
  }
});
