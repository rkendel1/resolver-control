/**
 * The criticality-lowering bypass (Boundry governance contract §4, ratchet), reproduced as the people who could
 * use it would: the proposing engineer holds catalog.write and lowers the dependency's criticality after proposing.
 * Lowering is allowed and audited; it must not reduce what the open change needs.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createTestApp } from "@feltdb/feltkit/testing";
import { api } from "../feltkit/_generated/api.js";
import { engineFor, seedResolver, settle, startResolver } from "./helpers.js";

test("a proposer lowering criticality (or an admin loosening policy) never lowers an open change's threshold", async () => {
  const resolver = await startResolver();
  const t = await createTestApp();
  const engine = engineFor(t, resolver);
  try {
    await seedResolver(resolver.admin);
    await t.as("ada").mutation(api.settings.set, { resolverUrl: resolver.url, namespaces: ["prod"] });
    await settle(engine, 1);
    const grace = t.as("grace"); // engineer: may propose and may describe dependencies (catalog.write)
    await grace.mutation(api.catalog.register, { ref: "ref://prod/search", title: "Search", category: "search", criticality: "critical", changeClass: "runtime" });
    const c = await grace.mutation(api.changes.proposeRetarget, { ref: "ref://prod/search", basedOnRevision: 1, binding: { value: { url: "https://search-b.example.com" } }, reason: "cheaper" });
    assert.equal(c.impact.requiredApprovals, 2);
    await settle(engine, 1);
    // The proposer lowers criticality; an admin also loosens the policy and unprotects prod.
    await grace.mutation(api.catalog.register, { ref: "ref://prod/search", title: "Search", category: "search", criticality: "low", changeClass: "runtime" });
    await t.as("ada").mutation(api.policies.set, { environment: "prod", protected: false, approvalsRequired: 1 });
    const view = await t.as("ada").query(api.changes.get, { id: c.id });
    assert.equal(view.requiredApprovals, 2, "what the approval signer reads still says two");
    await assert.rejects(t.as("barbara").mutation(api.changes.approve, { id: c.id }), (e: { code: string; message: string }) => e.code === "FORBIDDEN" && /protected/.test(e.message), "protection recorded at proposal still applies");
    const one = await t.as("linus").mutation(api.changes.approve, { id: c.id });
    assert.equal(one.status, "ready", "one approval is not enough for a change proposed as critical");
    const events = await t.as("ada").query(api.activity.list, {});
    assert.ok(JSON.stringify(events).includes("dependency.described"), "the lowering itself is audited");
    await settle(engine, 2);
    assert.equal((await resolver.admin.resolve("ref://prod/search")).revision, 1, "nothing executed");
    const two = await t.as("ada").mutation(api.changes.approve, { id: c.id });
    assert.equal(two.status, "approved");
  } finally {
    await engine.close(); await t.close(); await resolver.close();
  }
});
