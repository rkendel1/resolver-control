/**
 * Boundry governance contract 1.2.0 in Resolver Control: claiming execution ends withdrawal and rejection, whatever
 * happened since; abandonment is a person's decision, only once the claimed attempt was reconciled (requeued by the
 * component after establishing nothing reached Resolver); never withdrawal, never rollback.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createTestApp } from "@feltdb/feltkit/testing";
import { api } from "../feltkit/_generated/api.js";
import { EXECUTOR, engineFor, seedResolver, settle, startResolver } from "./helpers.js";

const code = (c: string, re?: RegExp) => (e: { code: string; message: string }) => e.code === c && (!re || re.test(e.message));

test("after claim: no withdrawal or rejection; abandonment only by a person, with a reason, once reconciled; evidence preserved", async () => {
  const resolver = await startResolver();
  const t = await createTestApp();
  const engine = engineFor(t, resolver);
  try {
    await seedResolver(resolver.admin);
    await t.as("ada").mutation(api.settings.set, { resolverUrl: resolver.url, namespaces: ["prod"] });
    await settle(engine, 1);
    await t.as("ada").mutation(api.policies.set, { environment: "prod", protected: true, approvalsRequired: 1 });
    const agent = t.as("ops-agent"), exe = t.as(EXECUTOR);
    const c = await agent.mutation(api.changes.proposeRetarget, { ref: "ref://prod/search", basedOnRevision: 1, binding: { value: { url: "https://search-b.example.com" } }, reason: "abandonment test" });
    await settle(engine, 1);
    await t.as("linus").mutation(api.changes.approve, { id: c.id });

    // Claimed, outcome open: everything refused, including abandonment (not reconciled yet).
    const claimed = await exe.mutation(api.changes.claim, { id: c.id });
    assert.equal(claimed.status, "executing");
    await assert.rejects(agent.mutation(api.changes.cancel, { id: c.id }), code("FAILED_PRECONDITION", /was claimed for execution/));
    await assert.rejects(t.as("ada").mutation(api.changes.reject, { id: c.id, note: "too late" }), code("FAILED_PRECONDITION", /was claimed for execution/));
    await assert.rejects(t.as("ada").mutation(api.changes.abandon, { id: c.id, reason: "stop it" }), code("FAILED_PRECONDITION", /not reconciled yet/));

    // The component establishes nothing reached Resolver and requeues: still claimed, now reconciled.
    const requeued = await exe.mutation(api.changes.settle, { id: c.id, attempt: 1, outcome: "requeue", note: "The approval signer could not be reached; nothing was sent to Resolver." });
    assert.equal(requeued.status, "approved");
    await assert.rejects(agent.mutation(api.changes.cancel, { id: c.id }), code("FAILED_PRECONDITION", /was claimed for execution \(attempt 1\)/), "requeued after a claim is still claimed");
    await assert.rejects(t.as("ada").mutation(api.changes.reject, { id: c.id, note: "reject now" }), code("FAILED_PRECONDITION", /was claimed/));
    await assert.rejects(agent.mutation(api.changes.abandon, { id: c.id, reason: "agent tries" }), code("FORBIDDEN"), "never an agent");
    await assert.rejects(t.as("grace").mutation(api.changes.abandon, { id: c.id, reason: "engineer tries" }), code("FORBIDDEN"));
    await assert.rejects(t.as("barbara").mutation(api.changes.abandon, { id: c.id, reason: "approver tries" }), code("FORBIDDEN"), "approver lacks abandon; prod_approver and admin hold it");
    await assert.rejects(exe.mutation(api.changes.abandon, { id: c.id, reason: "component tries" }), code("FORBIDDEN"));
    await assert.rejects(t.as("linus").mutation(api.changes.abandon, { id: c.id, reason: "" }), code("INVALID_ARGUMENT"), "a reason is required");

    const ab = await t.as("linus").mutation(api.changes.abandon, { id: c.id, reason: "provider B contract fell through" });
    assert.equal(ab.status, "abandoned");
    assert.deepEqual([ab.abandonment!.by, ab.abandonment!.atStatus, ab.abandonment!.attempt], ["linus", "approved", 1]);
    assert.match(ab.abandonment!.reconciliation.note, /nothing was sent to Resolver/);
    assert.deepEqual(ab.approvals.map((a) => a.by), ["linus"], "approvals preserved");
    assert.equal(ab.execution!.claimedBy, "component:resolver", "claim preserved");
    // Terminal: not claimed again, not picked up by the component, Resolver untouched.
    await assert.rejects(exe.mutation(api.changes.claim, { id: c.id }), code("FAILED_PRECONDITION"));
    const work = await exe.query(api.changes.work, {});
    assert.ok(![...work.execute, ...work.reconcile].some((x) => x.id === c.id));
    await settle(engine, 2);
    assert.equal((await resolver.admin.resolve("ref://prod/search")).revision, 1);
    const events = [...(await t.as("ada").query(api.activity.list, { subjectId: c.id }))].sort((a, b) => a.seq - b.seq).map((e) => e.type);
    assert.deepEqual(events.filter((e) => ["change.proposed", "change.approval_recorded", "change.execution_started", "change.requeued", "change.abandoned"].includes(e)), ["change.proposed", "change.approval_recorded", "change.execution_started", "change.requeued", "change.abandoned"], "append-only trail");

    // A replacement on the same reference is allowed (the abandoned change's reconciliation is on record).
    const next = await agent.mutation(api.changes.proposeRetarget, { ref: "ref://prod/search", basedOnRevision: 1, binding: { value: { url: "https://search-c.example.com" } }, reason: "replacement" });
    assert.equal(next.status, "proposed");

    // Before any claim, abandonment is the wrong tool.
    await settle(engine, 1);
    await assert.rejects(t.as("ada").mutation(api.changes.abandon, { id: next.id, reason: "not claimed" }), code("FAILED_PRECONDITION", /never claimed/));
  } finally {
    await engine.close(); await t.close(); await resolver.close();
  }
});
