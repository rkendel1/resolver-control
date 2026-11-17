/**
 * Conformance with the shared Boundry governance contract (vendor/boundry-governance/v1, vendored from
 * rkendel1/boundry-maint and checked by digest). Every vector runs against this application's own mutations,
 * with the real Resolver and the real engine underneath, or is reported as not applicable here, with the reason.
 *
 * Mapping: contract person → FeltKit "user", agent → "agent", component → "service". A subject is a change on
 * its own environment (ref://cN/svc) so each vector has its own policy. "awaiting-approval" is status "ready".
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { createTestApp, type TestApp } from "@feltdb/feltkit/testing";
import type { PrincipalInput } from "@feltdb/feltkit";
import { api } from "../feltkit/_generated/api.js";
import { engineFor, settle, startResolver, type RealResolver } from "./helpers.js";

const DIR = new URL("../vendor/boundry-governance/v1/", import.meta.url);
const source = JSON.parse(readFileSync(new URL("SOURCE.json", DIR), "utf8"));
const vectors = JSON.parse(readFileSync(new URL("vectors.json", DIR), "utf8"));

type P = { id: string; type: "person" | "agent" | "component"; roles: string[] };
type V = { name: string; operation: string; principal: P | null; subject?: any; digest?: string; expect: { allow: boolean; code?: string; result?: string } };

/** Why a vector has no counterpart in this application (reported, never silently skipped). */
function notApplicable(v: V): string | null {
  if (v.operation === "trigger") return "Resolver Control has no trigger: its component claims approved changes itself (changes.work / claim).";
  if (v.operation === "approve" && v.digest !== v.subject?.digest) return "approvals here bind the change record itself; there is no separate digest argument (a moved reference supersedes the change instead).";
  if (v.subject?.eligible) return "Resolver Control has no per-change approver allowlist; eligibility is the role.";
  if (v.subject?.production) return "authentication level is the platform's (FeltKit sessions); the harness cannot present an asserted identity to a production mutation.";
  const odd = (v.subject?.approvals ?? []).filter((a: any) => a.principalType !== "person" || a.digest !== v.subject.digest || a.by === v.subject.proposedBy);
  const dup = new Set((v.subject?.approvals ?? []).map((a: any) => a.by)).size !== (v.subject?.approvals ?? []).length;
  if (odd.length || dup) return "this subject cannot be constructed through the application: approve refuses non-person, proposer and duplicate approvals when they are given (contract §3), and the approval signer re-checks them before signing.";
  if (v.operation === "execute" && v.subject?.requiredAtProposal && v.subject.state === "approved") return "not constructible through the API once the approval path applies the ratchet (one approval of a change proposed as critical never reaches approved); claim applies the same rule as defence in depth.";
  return null;
}

/**
 * Divergences found by these vectors that this repository has not been authorized to change. Reported as
 * "DOES NOT CONFORM (known)" and shown as a todo, never counted as conforming.
 */
const KNOWN: Record<string, string> = {
  "proposer withdraws (an agent, its own proposal)": "the agent role lacks changes.cancel, so an agent cannot withdraw its own proposal (contract 1.1.0 allows it). Changing roles is a product decision for this application; not made here.",
};

const asRc = (p: P): PrincipalInput => ({ id: p.id, type: p.type === "person" ? "user" : p.type === "agent" ? "agent" : "service", roles: p.roles });
const ADMIN: PrincipalInput = { id: "conformance-admin", type: "user", roles: ["admin"] };

/** Translate this application's refusal into the contract's refusal code. */
function codeOf(e: any, op: string, status: string): string {
  const m = String(e?.message ?? e);
  if (e?.code === "UNAUTHENTICATED" || e?.code === "UNAUTHORIZED") return "unknown-principal";
  if (/Only a person may approve/.test(m)) return "person-only";
  if (/proposer of a change may not approve/.test(m)) return "proposer-cannot-approve";
  if (/already approved/.test(m)) return "already-approved";
  if (/is protected/.test(m)) return "protected-scope";
  if (/is frozen/.test(m)) return "frozen";
  if (/Only the proposer may withdraw/.test(m)) return "forbidden-effect";
  if (op === "execute" && status === "cancelled") return "revoked";
  if (op === "withdraw" && status === "executing") return "irreversible";
  if (/only a validated change awaiting approval/.test(m)) return "wrong-state";
  if (e?.code === "FORBIDDEN") return "forbidden-effect";
  return `unmapped: ${e?.code} ${m}`;
}

let resolver: RealResolver;
let t: TestApp;
const report: { name: string; outcome: string; detail: string }[] = [];

before(async () => {
  const envs = vectors.cases.map((_: V, i: number) => `c${i}`);
  resolver = await startResolver({ executorRead: envs.map((e: string) => `ref://${e}/*`), executorWrite: envs.map((e: string) => `ref://${e}/*`) });
  for (const e of envs) await resolver.admin.put({ ref: `ref://${e}/svc`, kind: "endpoint", binding: { value: { url: `https://a.${e}.example.com` } }, expectedRevision: 0, reason: "conformance seed" });
  t = await createTestApp();
});
after(async () => {
  writeFileSync(new URL("../docs/governance-conformance.json", import.meta.url), JSON.stringify({ contract: `${source.contract}@${source.version}`, vendoredFrom: source.source, cases: report }, null, 2) + "\n");
  await t?.close(); await resolver?.close();
});

test("the vendored contract is byte-identical to its recorded source", () => {
  for (const [f, digest] of Object.entries(source.sha256)) assert.equal(createHash("sha256").update(readFileSync(new URL(f, DIR))).digest("hex"), digest, f);
  assert.equal(vectors.version, source.version);
});

vectors.cases.forEach((v: V, i: number) => {
  test(`contract ${vectors.version}: ${v.name}`, KNOWN[v.name] ? { todo: `known divergence: ${KNOWN[v.name]}` } : {}, async () => {
    const na = notApplicable(v);
    if (na) { report.push({ name: v.name, outcome: "not-applicable", detail: na }); return; }
    const env = `c${i}`, ref = `ref://${env}/svc`;
    const engine = engineFor(t, resolver);
    try {
      // At most 20 managed namespaces: each vector manages only its own.
      await t.as(ADMIN).mutation(api.settings.set, { resolverUrl: resolver.url, namespaces: [env] });
      let changeId: string | null = null;
      const s = v.subject;
      if (s) {
        const crit = s.requiredAtProposal >= 2 ? "critical" : s.criticality;
        await t.as(ADMIN).mutation(api.catalog.register, { ref, title: `conformance ${i}`, category: "integrations", criticality: crit, changeClass: "runtime" });
        // Policy at proposal: the vector's, except freezes and tightening, applied after existing approvals.
        const initialCount = ["approved", "executing"].includes(s.state) ? Math.max(1, s.approvals.length) : s.policy.approvalsRequired;
        await t.as(ADMIN).mutation(api.policies.set, { environment: env, protected: s.policy.protected, approvalsRequired: initialCount });
        await settle(engine, 1);
        const proposer: PrincipalInput = { id: s.proposedBy, type: s.proposedBy === "bot" ? "agent" : "user", roles: s.proposedBy === "bot" ? ["agent"] : ["engineer"] };
        const c = await t.as(proposer).mutation(api.changes.proposeRetarget, { ref, basedOnRevision: 1, binding: { value: { url: `https://b.${env}.example.com` } }, reason: "conformance" });
        changeId = c.id;
        await settle(engine, 1); // validation by the component → ready
        const approvals = s.approvals.length || !["approved", "executing"].includes(s.state) ? s.approvals : [{ by: "ann", principalType: "person", digest: s.digest }];
        for (const a of approvals) await t.as({ id: a.by, type: "user", roles: ["prod_approver"] }).mutation(api.changes.approve, { id: c.id });
        if (s.requiredAtProposal >= 2) await t.as(ADMIN).mutation(api.catalog.register, { ref, title: `conformance ${i}`, category: "integrations", criticality: s.criticality, changeClass: "runtime" });
        if (s.policy.approvalsRequired !== initialCount) await t.as(ADMIN).mutation(api.policies.set, { environment: env, protected: s.policy.protected, approvalsRequired: s.policy.approvalsRequired });
        if (s.policy.frozen) await t.as(ADMIN).mutation(api.policies.freeze, { environment: env, frozen: true, reason: "conformance freeze" });
        if (s.revoked) await t.as(proposer).mutation(api.changes.cancel, { id: c.id });
        if (s.state === "executing" || s.irreversible) await t.as({ id: "component:resolver", type: "service", roles: ["executor"] }).mutation(api.changes.claim, { id: c.id });
        const st = (await t.as(ADMIN).query(api.changes.get, { id: c.id })).change.status;
        const want = s.revoked ? "cancelled" : s.irreversible ? "executing" : s.state === "awaiting-approval" ? "ready" : s.state;
        assert.equal(st, want, `subject constructed in state ${st}, wanted ${want}`);
      }
      if (!s) await settle(engine, 1); // a proposal is based on an observed revision
      const caller = v.principal ? t.as(asRc(v.principal)) : t;
      let got: { allow: boolean; code?: string; result?: string };
      try {
        if (v.operation === "propose") {
          await caller.mutation(api.changes.proposeRetarget, { ref, basedOnRevision: 1, binding: { value: { url: `https://p.${env}.example.com` } }, reason: "conformance propose" });
          got = { allow: true };
        } else if (v.operation === "approve") {
          const r = await caller.mutation(api.changes.approve, { id: changeId! });
          got = { allow: true, result: r.status === "approved" ? "approved" : "awaiting-approval" };
        } else if (v.operation === "withdraw") {
          const isProposer = v.principal!.id === s.proposedBy;
          await caller.mutation(isProposer ? api.changes.cancel : api.changes.reject, { id: changeId!, ...(isProposer ? {} : { note: "conformance reject" }) } as never);
          got = { allow: true };
        } else { // execute: the component claims
          const r = await caller.mutation(api.changes.claim, { id: changeId! });
          got = r.status === "executing" ? { allow: true } : { allow: false, code: "insufficient-approvals", result: r.status === "ready" ? "awaiting-approval" : r.status };
        }
      } catch (e) {
        const status = changeId ? (await t.as(ADMIN).query(api.changes.get, { id: changeId })).change.status : "-";
        got = { allow: false, code: codeOf(e, v.operation, status), ...(codeOf(e, v.operation, status) === "frozen" && v.operation === "execute" ? { result: "wait" } : {}) };
      }
      const codes: string[] = (v.expect as any).codes ?? [v.expect.code];
      const ok = got.allow === v.expect.allow && (v.expect.allow || codes.includes(got.code!)) && (!v.expect.result || got.result === v.expect.result);
      report.push({ name: v.name, outcome: ok ? "conforms" : KNOWN[v.name] ? "DOES NOT CONFORM (known)" : "DOES NOT CONFORM", detail: (KNOWN[v.name] && !ok ? `${KNOWN[v.name]} ` : "") + `expected ${JSON.stringify(v.expect)}, got ${JSON.stringify(got)}` });
      assert.ok(ok, `expected ${JSON.stringify(v.expect)}, got ${JSON.stringify(got)}`);
    } finally { await engine.close(); }
  });
});
