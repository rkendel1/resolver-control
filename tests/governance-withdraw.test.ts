/**
 * Agent withdrawal, narrowly: an agent may withdraw its OWN proposal until execution is claimed. Withdrawal is an
 * append-only terminal transition (status, decision, audit event); it never erases approvals or evidence, and grants
 * nothing else: no approving, rejecting, claiming, executing, or withdrawing someone else's proposal.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createTestApp } from "@feltdb/feltkit/testing";
import { api } from "../feltkit/_generated/api.js";
import { EXECUTOR, engineFor, seedResolver, settle, startResolver } from "./helpers.js";

const forbidden = (re: RegExp) => (e: { code: string; message: string }) => e.code === "FORBIDDEN" && re.test(e.message);
const precondition = (e: { code: string }) => e.code === "FAILED_PRECONDITION";

test("an agent withdraws only its own proposals, only before execution is claimed, and leaves the evidence intact", async () => {
  const resolver = await startResolver();
  const t = await createTestApp();
  const engine = engineFor(t, resolver);
  try {
    await seedResolver(resolver.admin);
    await t.as("ada").mutation(api.settings.set, { resolverUrl: resolver.url, namespaces: ["prod", "staging"] });
    await settle(engine, 1);
    await t.as("ada").mutation(api.policies.set, { environment: "prod", protected: true, approvalsRequired: 1 });
    const agent = t.as("ops-agent");
    const propose = (who: typeof agent, ref: string, url: string) => who.mutation(api.changes.proposeRetarget, { ref, basedOnRevision: 1, binding: { value: { url } }, reason: "withdrawal boundary test" });

    // 1. Its own, awaiting approval: withdrawn.
    const own = await propose(agent, "ref://prod/search", "https://search-b.example.com");
    await settle(engine, 1);
    const w1 = await agent.mutation(api.changes.cancel, { id: own.id, note: "no longer wanted" });
    assert.equal(w1.status, "cancelled");
    assert.deepEqual([w1.decision!.outcome, w1.decision!.by, w1.decision!.note], ["cancelled", "ops-agent", "no longer wanted"]);

    // 2. Someone else's: refused; and an agent cannot reject (that needs changes.approve).
    const graces = await propose(t.as("grace"), "ref://staging/search", "https://search-c.example.com");
    await settle(engine, 1);
    await assert.rejects(agent.mutation(api.changes.cancel, { id: graces.id }), forbidden(/Only the proposer may withdraw/));
    await assert.rejects(agent.mutation(api.changes.reject, { id: graces.id, note: "agent tries to reject" }), forbidden(/changes\.approve/));
    assert.equal((await t.as("ada").query(api.changes.get, { id: graces.id })).change.status, "ready", "untouched");

    // 3. Its own, approved by a person but not yet claimed: withdrawn; the approval stays on the record.
    const approved = await propose(agent, "ref://prod/search", "https://search-d.example.com");
    await settle(engine, 1);
    await t.as("linus").mutation(api.changes.approve, { id: approved.id, note: "looks fine" });
    const w3 = await agent.mutation(api.changes.cancel, { id: approved.id });
    assert.equal(w3.status, "cancelled");
    assert.deepEqual(w3.approvals.map((a) => a.by), ["linus"], "withdrawal never erases approvals");
    assert.ok(w3.validation, "nor validation evidence");
    // Terminal: it can be neither approved again nor claimed.
    await assert.rejects(t.as("ada").mutation(api.changes.approve, { id: approved.id }), precondition);
    await assert.rejects(t.as(EXECUTOR).mutation(api.changes.claim, { id: approved.id }), precondition);
    const events = [...(await t.as("ada").query(api.activity.list, { subjectId: approved.id }))].sort((a, b) => a.seq - b.seq).map((e) => [e.type, e.actor]); // newest first → in order
    assert.deepEqual(events.filter(([type]) => ["change.proposed", "change.approval_recorded", "change.cancelled"].includes(type as string)), [["change.proposed", "ops-agent"], ["change.approval_recorded", "linus"], ["change.cancelled", "ops-agent"]], "append-only audit: proposal, approval and withdrawal, each by its actor");

    // 4. Its own, claimed for execution: refused. Reversal from here is a new governed change.
    const claimed = await propose(agent, "ref://prod/search", "https://search-e.example.com");
    await settle(engine, 1);
    await t.as("linus").mutation(api.changes.approve, { id: claimed.id });
    const c = await t.as(EXECUTOR).mutation(api.changes.claim, { id: claimed.id });
    assert.equal(c.status, "executing");
    await assert.rejects(agent.mutation(api.changes.cancel, { id: claimed.id }), precondition);
    assert.equal((await t.as("ada").query(api.changes.get, { id: claimed.id })).change.status, "executing", "unchanged by the refused withdrawal");

    // 5. Nothing else was granted.
    await assert.rejects(agent.mutation(api.changes.approve, { id: graces.id }), forbidden(/changes\.approve/));
    await assert.rejects(agent.mutation(api.changes.claim, { id: graces.id }), forbidden(/changes\.execute/));
  } finally {
    await engine.close(); await t.close(); await resolver.close();
  }
});
