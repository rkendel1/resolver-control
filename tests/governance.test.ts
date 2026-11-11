/**
 * Governed execution across the real boundaries: Resolver 0.4.0 enforcing a mutation policy (in process,
 * its own install), the approval signer serving HTTP (signer/server.ts) and reading this application as
 * its own principal, and the engine acting as the component principal. Faults are injected by wrapping the
 * real client or the signer's reader; Resolver and the signer are never faked.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { ResolverClient, ResolverClientError } from "@appport/resolver-client";
import { generateSigningKey } from "@appport/resolver-client/authorization";
import { createTestApp, type TestApp } from "@feltdb/feltkit/testing";
import { api } from "../feltkit/_generated/api.js";
import type { Connect } from "../component/engine.js";
import { SIGNER_RETRY_MS } from "../component/engine.js";
import { createSigner, type Reader } from "../signer/core.js";
import { SourceUnavailable, startSigner, publicKeyOf } from "../signer/server.js";
import { engineFor, seedResolver, settle, startResolver, type RealResolver } from "./helpers.js";

const SIGNER = { id: "service:approval-signer", type: "service" as const, roles: ["signer"] };
const ISSUER = "resolver-control";
const searchB = { value: { url: "https://search-b.example.com" } };

interface Operator {
  setPolicy(p: unknown, i: unknown): Promise<unknown>;
  addSigningKey(p: unknown, i: unknown): Promise<unknown>;
  revokeSigningKey(p: unknown, i: unknown): Promise<unknown>;
  put(p: unknown, i: unknown): Promise<{ revision: number }>;
  history(p: unknown, i: unknown): Promise<{ entries: Array<{ revision: number; actor: string; reason?: string; governance?: { mode: string; jti?: string; decision?: string } }> }>;
}

/** The app's own reader for the signer: the signer's principal, calling the same functions its HTTP reader calls. */
function appReader(t: TestApp): Reader {
  const as = t.as(SIGNER);
  return {
    change: async (id) => {
      try {
        return (await as.query(api.changes.get, { id })) as never;
      } catch (error) {
        if ((error as { code?: string }).code === "NOT_FOUND") return null;
        throw error;
      }
    },
    events: async (id) => (await as.query(api.activity.list, { subjectId: id, limit: 500 })) as never,
  };
}

interface Setup {
  resolver: RealResolver;
  t: TestApp;
  operator: unknown;
  r: Operator;
  key: { publicKey: string; privateKeyPem: string; kid: string };
  signer: { url: string; close(): Promise<void> };
  token: string;
  log: Array<Record<string, unknown>>;
}

async function setup(options: { scope?: string[]; minApprovals?: number; now?: () => Date; reader?: (base: Reader) => Reader; port?: number } = {}): Promise<Setup> {
  const resolver = await startResolver();
  const t = await createTestApp();
  await seedResolver(resolver.admin);
  await t.as("ada").mutation(api.demo.seed, {});
  // Resolver's host operator: prod is governed; the signer's public key is trusted for issuer resolver-control.
  const runtime = resolver.runtime as { operator(tenant: string): unknown; resolver: Operator };
  const operator = runtime.operator("acme");
  const generated = generateSigningKey();
  const key = { ...generated, kid: "rc-test-1" };
  await runtime.resolver.setPolicy(operator, { id: "prod", pattern: "ref://prod/*", operations: ["put", "put-secret", "rollback", "revoke"], issuers: [ISSUER], maxValiditySeconds: 600, reason: "prod is governed" });
  await runtime.resolver.addSigningKey(operator, { kid: key.kid, issuer: ISSUER, publicKey: key.publicKey, reason: "Resolver Control approval signer" });
  const token = randomBytes(24).toString("base64url");
  const log: Array<Record<string, unknown>> = [];
  const base = appReader(t);
  const signer = await startSigner({
    privateKey: key.privateKeyPem,
    kid: key.kid,
    issuer: ISSUER,
    tenant: "acme",
    scope: options.scope ?? ["ref://prod/*", "ref://staging/*"],
    executor: "component:resolver",
    minApprovals: options.minApprovals ?? 1,
    validitySeconds: 300,
    maxClaimAgeMs: 60_000,
    reader: options.reader ? options.reader(base) : base,
    clientToken: token,
    ...(options.now ? { now: options.now } : {}),
    ...(options.port ? { port: options.port } : {}),
    log: (e) => log.push(e),
  });
  await t.as("ada").mutation(api.settings.set, { resolverUrl: resolver.url, namespaces: ["prod", "staging"], signerUrl: signer.url });
  return { resolver, t, operator, r: runtime.resolver, key, signer, token, log };
}

async function teardown(s: Setup, ...engines: Array<{ close(): Promise<void> }>) {
  for (const e of engines) await e.close();
  await s.signer.close().catch(() => undefined);
  await s.t.close();
  await s.resolver.close();
}

async function proposeAndApprove(s: Setup, engine: Parameters<typeof settle>[0], binding: unknown = searchB, ref = "ref://prod/search", basedOnRevision = 1, approvers = ["linus"]) {
  const change = await s.t.as("grace").mutation(api.changes.proposeRetarget, { ref, basedOnRevision, binding, reason: "Switch search provider" });
  await settle(engine, 1);
  assert.equal((await s.t.as("ada").query(api.changes.get, { id: change.id })).change.status, "ready");
  for (const who of approvers) await s.t.as(who).mutation(api.changes.approve, { id: change.id });
  return change;
}

const get = async (s: Setup, id: string) => (await s.t.as("ada").query(api.changes.get, { id })).change;
const history = async (s: Setup, ref: string) => (await s.r.history(s.operator, { ref })).entries;

test("an approved change executes with an authorization the signer issued from the record; Resolver verifies and consumes it; verification checks it", async () => {
  const s = await setup();
  const engine = engineFor(s.t, s.resolver, { signerToken: s.token });
  try {
    await settle(engine, 1);
    const change = await proposeAndApprove(s, engine);
    await engine.tick();
    const done = await get(s, change.id);
    assert.equal(done.status, "verified", JSON.stringify(done.execution));
    assert.equal(done.execution!.authorization!.jti, `${change.id}.1`);
    const authorizationCheck = done.verification!.checks.find((c) => c.id === "authorization");
    assert.equal(authorizationCheck?.outcome, "pass");
    assert.equal(done.verification!.governance?.mode, "authorized");
    assert.equal(done.verification!.governance?.decision, change.id);
    assert.deepEqual(done.verification!.governance?.approvers, ["linus"]);
    // Resolver's own record: the revision carries the authorization, consumed with it.
    const entry = (await history(s, "ref://prod/search")).at(-1)!;
    assert.equal(entry.revision, 2);
    assert.equal(entry.governance?.mode, "authorized");
    assert.equal(entry.governance?.jti, `${change.id}.1`);
    // The audit trail names the issuance (id and expiry only; never the token).
    const events = await s.t.as("ada").query(api.activity.list, { subjectId: change.id });
    const issued = events.find((e) => e.type === "change.authorization_issued");
    assert.ok(issued);
    assert.ok(!JSON.stringify(events).includes("eyJ"), "no token in the audit trail");
    assert.ok(!JSON.stringify(done).includes("eyJ"), "no token in the change record");
    assert.deepEqual(s.log.map((e) => e.event), ["sign.issued"]);
  } finally {
    await teardown(s, engine);
  }
});

test("governed rollback: the signer binds the restored revision; Resolver applies it", async () => {
  const s = await setup();
  const engine = engineFor(s.t, s.resolver, { signerToken: s.token });
  try {
    await settle(engine, 1);
    const first = await proposeAndApprove(s, engine);
    await engine.tick();
    assert.equal((await get(s, first.id)).status, "verified");
    await settle(engine, 1);
    const revert = await s.t.as("grace").mutation(api.changes.proposeRevert, { id: first.id, reason: "Back to provider A" });
    await settle(engine, 1);
    await s.t.as("linus").mutation(api.changes.approve, { id: revert.id });
    await engine.tick();
    const done = await get(s, revert.id);
    assert.equal(done.status, "verified", JSON.stringify(done.execution));
    const entry = (await history(s, "ref://prod/search")).at(-1)!;
    assert.equal(entry.revision, 3);
    assert.equal(entry.governance?.jti, `${revert.id}.1`);
    assert.match(((await s.resolver.admin.resolve("ref://prod/search")).selected.value as unknown as { url: string }).url, /^https:\/\/search-a\.example\.com\/?$/);
  } finally {
    await teardown(s, engine);
  }
});

test("without the signer token the component does not claim: approved changes wait and Resolver is untouched", async () => {
  const s = await setup();
  const engine = engineFor(s.t, s.resolver); // signerUrl is set, the credential is not
  try {
    await settle(engine, 1);
    const change = await proposeAndApprove(s, engine);
    const report = await engine.tick();
    assert.match(report.detail ?? "", /approval-signer-token/);
    assert.equal((await get(s, change.id)).status, "approved");
    assert.equal((await history(s, "ref://prod/search")).length, 1);
  } finally {
    await teardown(s, engine);
  }
});

test("the signer refuses what the record does not support, and nothing reaches Resolver", async (t) => {
  await t.test("out of scope: the change fails with the signer's reason", async () => {
    const s = await setup({ scope: ["ref://staging/*"] });
    const engine = engineFor(s.t, s.resolver, { signerToken: s.token });
    try {
      await settle(engine, 1);
      const change = await proposeAndApprove(s, engine);
      await engine.tick();
      const done = await get(s, change.id);
      assert.equal(done.status, "failed");
      assert.equal(done.execution!.error!.code, "SIGNER_REFUSED");
      assert.equal(done.execution!.error!.reason, "signer.out-of-scope");
      assert.equal((await history(s, "ref://prod/search")).length, 1, "Resolver unchanged");
    } finally {
      await teardown(s, engine);
    }
  });

  await t.test("fewer approvals than the signer's floor, whatever this application's policy says", async () => {
    const s = await setup({ minApprovals: 2 });
    const engine = engineFor(s.t, s.resolver, { signerToken: s.token });
    try {
      await settle(engine, 1);
      const change = await proposeAndApprove(s, engine);
      await engine.tick();
      const done = await get(s, change.id);
      assert.equal(done.status, "failed");
      assert.equal(done.execution!.error!.reason, "signer.insufficient-approvals");
      assert.equal((await history(s, "ref://prod/search")).length, 1);
    } finally {
      await teardown(s, engine);
    }
  });

  await t.test("a leaked client token cannot get a change signed that is not being executed, or a different attempt", async () => {
    const s = await setup();
    const engine = engineFor(s.t, s.resolver, { signerToken: s.token });
    try {
      await settle(engine, 1);
      const proposed = await s.t.as("grace").mutation(api.changes.proposeRetarget, { ref: "ref://prod/search", basedOnRevision: 1, binding: searchB, reason: "not yet approved" });
      await settle(engine, 1);
      const ask = (body: unknown, token = s.token) => fetch(`${s.signer.url}/sign`, { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: JSON.stringify(body) });
      let res = await ask({ changeId: proposed.id, attempt: 1 });
      assert.equal(res.status, 403);
      assert.equal((await res.json()).reason, "signer.not-executing");
      res = await ask({ changeId: proposed.id, attempt: 1 }, "wrong-token");
      assert.equal(res.status, 401);
      res = await ask({ changeId: "nope", attempt: 1 });
      assert.equal((await res.json()).reason, "signer.not-found");
      // Extra fields are ignored: claims come from the record, never the request.
      await s.t.as("linus").mutation(api.changes.approve, { id: proposed.id });
      const claimed = await s.t.as({ id: "component:resolver", type: "service", roles: ["executor"] }).mutation(api.changes.claim, { id: proposed.id });
      res = await ask({ changeId: proposed.id, attempt: claimed.execution!.attempt + 1 });
      assert.equal((await res.json()).reason, "signer.attempt-mismatch");
      res = await ask({ changeId: proposed.id, attempt: claimed.execution!.attempt, ref: "ref://prod/payments", binding: { value: { url: "https://evil.example.com" } }, expectedRevision: 9 });
      const body = await res.json();
      assert.equal(res.status, 200);
      const claims = JSON.parse(Buffer.from(body.authorization.split(".")[1], "base64url").toString());
      assert.equal(claims.ref, "ref://prod/search");
      assert.equal(claims.expectedRevision, 1);
      assert.equal(claims.decision, proposed.id);
      assert.equal((await history(s, "ref://prod/search")).length, 1, "issuing writes nothing");
    } finally {
      await teardown(s, engine);
    }
  });

  await t.test("a tampered record (an approval with no audit event, or not by a person, or by the proposer) is refused", async () => {
    let tamper: "unrecorded" | "not-person" | "self" = "unrecorded";
    const s = await setup({
      reader: (base) => ({
        async change(id) {
          const view = await base.change(id);
          if (!view) return view;
          if (tamper === "unrecorded") view.change.approvals = [...view.change.approvals, { by: "mallory", at: Date.now() }];
          if (tamper === "self") view.change.approvals = [{ by: view.change.proposedBy, at: Date.now() }];
          return view;
        },
        async events(id) {
          const events = await base.events(id);
          return tamper === "not-person" ? events.map((e) => (e.type === "change.approval_recorded" ? { ...e, actorType: "agent" } : e)) : events;
        },
      }),
    });
    const engine = engineFor(s.t, s.resolver, { signerToken: s.token });
    try {
      await settle(engine, 1);
      const reasons = [];
      for (const [mode, ref, binding] of [["unrecorded", "ref://prod/search", searchB], ["not-person", "ref://staging/search", { value: { url: "https://search-c.example.com" } }]] as const) {
        tamper = mode;
        const change = await proposeAndApprove(s, engine, binding, ref);
        await engine.tick();
        const done = await get(s, change.id);
        assert.equal(done.status, "failed");
        reasons.push(done.execution!.error!.reason);
      }
      assert.deepEqual(reasons, ["signer.approval-unrecorded", "signer.approval-not-by-person"]);
      tamper = "self";
      const change = await s.t.as("grace").mutation(api.changes.proposeRetarget, { ref: "ref://prod/ai/default", basedOnRevision: 1, binding: { value: { provider: "openai", model: "gpt-4o-mini", credential: "ref://prod/llm/primary-key" } }, reason: "self-approved" });
      await settle(engine, 1);
      await s.t.as("linus").mutation(api.changes.approve, { id: change.id });
      await engine.tick();
      assert.equal((await get(s, change.id)).execution!.error!.reason, "signer.self-approval");
      assert.equal((await history(s, "ref://prod/search")).length, 1);
      assert.equal((await history(s, "ref://prod/ai/default")).length, 1);
    } finally {
      await teardown(s, engine);
    }
  });
});

test("an expired authorization is refused by Resolver; the change fails and the reference is unchanged", async () => {
  // A signer whose clock is ten minutes behind: its authorizations expired before they were issued, by Resolver's clock.
  const s = await setup({ now: () => new Date(Date.now() - 10 * 60_000) });
  const engine = engineFor(s.t, s.resolver, { signerToken: s.token });
  try {
    await settle(engine, 1);
    const change = await proposeAndApprove(s, engine);
    await engine.tick();
    const done = await get(s, change.id);
    assert.equal(done.status, "failed", JSON.stringify(done.execution));
    assert.equal(done.execution!.error!.reason, "resolver.authorization-invalid");
    assert.match(done.execution!.error!.message, /expired/);
    assert.equal((await history(s, "ref://prod/search")).length, 1);
  } finally {
    await teardown(s, engine);
  }
});

test("a revoked signing key: Resolver refuses the authorization; nothing changes", async () => {
  const s = await setup();
  const engine = engineFor(s.t, s.resolver, { signerToken: s.token });
  try {
    await settle(engine, 1);
    const change = await proposeAndApprove(s, engine);
    await s.r.revokeSigningKey(s.operator, { kid: s.key.kid, reason: "key compromised" });
    await engine.tick();
    const done = await get(s, change.id);
    assert.equal(done.status, "failed");
    assert.equal(done.execution!.error!.reason, "resolver.authorization-invalid");
    assert.equal((await history(s, "ref://prod/search")).length, 1);
  } finally {
    await teardown(s, engine);
  }
});

test("the signer is down, then back: the change waits under the same approval, then executes once", async () => {
  const s = await setup();
  let clock = Date.now();
  const engine = engineFor(s.t, s.resolver, { signerToken: s.token, now: () => clock });
  try {
    await settle(engine, 1);
    const change = await proposeAndApprove(s, engine);
    const port = Number(new URL(s.signer.url).port);
    await s.signer.close();
    await engine.tick();
    let state = await get(s, change.id);
    assert.equal(state.status, "approved", "requeued, not failed");
    assert.equal(state.execution!.error!.code, "SIGNER_UNAVAILABLE");
    // Backoff: the next pass does not claim it again at once.
    await engine.tick();
    assert.equal((await get(s, change.id)).execution!.attempt, 1);
    // The signer comes back on the same address.
    s.signer = await startSigner({ privateKey: s.key.privateKeyPem, kid: s.key.kid, issuer: ISSUER, tenant: "acme", scope: ["ref://prod/*"], executor: "component:resolver", minApprovals: 1, validitySeconds: 300, maxClaimAgeMs: 60_000, reader: appReader(s.t), clientToken: s.token, port, log: () => undefined });
    clock = Date.now() + SIGNER_RETRY_MS + 1;
    await engine.tick();
    state = await get(s, change.id);
    assert.equal(state.status, "verified", JSON.stringify(state.execution));
    assert.equal(state.execution!.attempt, 2);
    assert.equal(state.verification!.governance?.jti, `${change.id}.2`);
    assert.equal((await history(s, "ref://prod/search")).length, 2, "one write");
    const types = (await s.t.as("ada").query(api.activity.list, { subjectId: change.id })).map((e) => e.type).reverse();
    assert.deepEqual(types.filter((x) => x.startsWith("change.") && !x.startsWith("change.approval") && x !== "change.proposed" && x !== "change.validated"), ["change.approved", "change.execution_started", "change.requeued", "change.execution_started", "change.authorization_issued", "change.verified"]);
  } finally {
    await teardown(s, engine);
  }
});

test("the signer cannot read this application: it answers 503 and the change waits", async () => {
  let down = true;
  const s = await setup({ reader: (base) => ({ change: async (id) => (down ? Promise.reject(new SourceUnavailable("Resolver Control did not answer")) : base.change(id)), events: base.events }) });
  let clock = Date.now();
  const engine = engineFor(s.t, s.resolver, { signerToken: s.token, now: () => clock });
  try {
    await settle(engine, 1);
    const change = await proposeAndApprove(s, engine);
    await engine.tick();
    let state = await get(s, change.id);
    assert.equal(state.status, "approved");
    assert.equal(state.execution!.error!.reason, "signer.source-unavailable");
    down = false;
    clock = Date.now() + SIGNER_RETRY_MS + 1;
    await engine.tick();
    state = await get(s, change.id);
    assert.equal(state.status, "verified");
  } finally {
    await teardown(s, engine);
  }
});

test("concurrent approvals: two people approve at once; the change needs both, is approved once and executes once", async () => {
  const s = await setup();
  const engine = engineFor(s.t, s.resolver, { signerToken: s.token });
  try {
    await s.t.as("ada").mutation(api.policies.set, { environment: "prod", protected: true, approvalsRequired: 2 });
    await settle(engine, 1);
    const change = await s.t.as("grace").mutation(api.changes.proposeRetarget, { ref: "ref://prod/search", basedOnRevision: 1, binding: searchB, reason: "two approvals" });
    await settle(engine, 1);
    const results = await Promise.allSettled([s.t.as("linus").mutation(api.changes.approve, { id: change.id }), s.t.as("ada").mutation(api.changes.approve, { id: change.id })]);
    // Whatever FeltDB's conflict handling does, no approval is lost or counted twice: retry any that lost the race.
    for (const [i, r] of results.entries()) if (r.status === "rejected") await s.t.as(i === 0 ? "linus" : "ada").mutation(api.changes.approve, { id: change.id });
    let state = await get(s, change.id);
    assert.deepEqual(state.approvals.map((a) => a.by).sort(), ["ada", "linus"]);
    assert.equal(state.status, "approved");
    await engine.tick();
    state = await get(s, change.id);
    assert.equal(state.status, "verified", JSON.stringify(state.execution));
    assert.deepEqual([...(state.verification!.governance?.approvers ?? [])].sort(), ["ada", "linus"]);
    const approved = (await s.t.as("ada").query(api.activity.list, { subjectId: change.id })).filter((e) => e.type === "change.approved");
    assert.equal(approved.length, 1);
  } finally {
    await teardown(s, engine);
  }
});

test("two executors at once: one claim wins, one authorization is consumed, one revision is written", async () => {
  const s = await setup();
  const a = engineFor(s.t, s.resolver, { signerToken: s.token });
  const b = engineFor(s.t, s.resolver, { signerToken: s.token });
  try {
    await settle(a, 1);
    await settle(b, 1);
    const change = await proposeAndApprove(s, a);
    await Promise.all([a.tick(), b.tick()]);
    await settle(a, 2);
    const state = await get(s, change.id);
    assert.equal(state.status, "verified", JSON.stringify(state.execution));
    const entries = await history(s, "ref://prod/search");
    assert.equal(entries.length, 2, "exactly one write");
    assert.equal(entries.filter((e) => e.governance?.decision === change.id).length, 1);
  } finally {
    await teardown(s, a, b);
  }
});

test("stale revision: an operator break-glass write after approval; the signed write is refused as stale and the change is superseded; the break-glass is surfaced", async () => {
  const s = await setup();
  const engine = engineFor(s.t, s.resolver, { signerToken: s.token });
  try {
    await settle(engine, 1);
    const change = await proposeAndApprove(s, engine);
    await s.r.put(s.operator, { ref: "ref://prod/search", binding: { value: { url: "https://search-emergency.example.com" } }, expectedRevision: 1, reason: "provider A outage", breakGlass: { reason: "search provider A is down" } });
    await engine.tick();
    const done = await get(s, change.id);
    assert.equal(done.status, "superseded", JSON.stringify(done.execution));
    assert.equal((await history(s, "ref://prod/search")).length, 2, "only the operator's write");
    const events = await s.t.as("ada").query(api.activity.list, { ref: "ref://prod/search" });
    const glass = events.find((e) => e.type === "resolver.change.break_glass");
    assert.ok(glass, events.map((e) => e.type).join(", "));
    assert.equal((glass!.data as { reason: string }).reason, "search provider A is down");
  } finally {
    await teardown(s, engine);
  }
});

function faulty(mode: "after-write" | "before-write"): { connect: Connect; lost: () => number } {
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

test("the governed write happened but its answer was lost: reconciled by the authorization Resolver consumed; verified once", async () => {
  const s = await setup();
  const fault = faulty("after-write");
  const engine = engineFor(s.t, s.resolver, { signerToken: s.token, connect: fault.connect });
  try {
    await settle(engine, 1);
    const change = await proposeAndApprove(s, engine);
    await engine.tick();
    assert.equal((await get(s, change.id)).status, "unknown");
    await engine.tick();
    const done = await get(s, change.id);
    assert.equal(done.status, "verified", JSON.stringify(done.execution));
    assert.equal(done.verification!.governance?.jti, `${change.id}.1`, "the first attempt's authorization");
    assert.equal((await history(s, "ref://prod/search")).length, 2);
  } finally {
    await teardown(s, engine);
  }
});

test("Resolver unreachable after signing: nothing applied; requeued; a new attempt with a new authorization; the first is never consumed", async () => {
  const s = await setup();
  const fault = faulty("before-write");
  const engine = engineFor(s.t, s.resolver, { signerToken: s.token, connect: fault.connect });
  try {
    await settle(engine, 1);
    const change = await proposeAndApprove(s, engine);
    await engine.tick(); // attempt 1: signed, write lost before Resolver → unknown
    await engine.tick(); // attempt 2: reconcile: not applied → requeue
    await engine.tick(); // attempt 3: signed again, written
    const done = await get(s, change.id);
    assert.equal(done.status, "verified", JSON.stringify(done.execution));
    const jtis = (await s.t.as("ada").query(api.activity.list, { subjectId: change.id })).filter((e) => e.type === "change.authorization_issued").map((e) => (e.data as { jti: string }).jti).reverse();
    assert.deepEqual(jtis, [`${change.id}.1`, `${change.id}.3`]);
    const entries = await history(s, "ref://prod/search");
    assert.equal(entries.length, 2);
    assert.equal(entries.at(-1)!.governance?.jti, `${change.id}.3`);
  } finally {
    await teardown(s, engine);
  }
});

test("adoption: a live consumer fetches the new revision (observed) and reports using it (asserted); an idle instance stays not yet fetched", async () => {
  const s = await setup();
  const engine = engineFor(s.t, s.resolver, { signerToken: s.token, consumersIntervalMs: 0 });
  const as = (instance: string) => ({ application: "search-frontend", environment: "prod", instance, dependencies: ["ref://prod/search"] });
  const web1 = await ResolverClient.connect({ url: s.resolver.url, apiKey: s.resolver.consumerKey, live: true, consumer: as("web-1") });
  const web2 = await ResolverClient.connect({ url: s.resolver.url, apiKey: s.resolver.consumerKey, live: true, consumer: as("web-2") });
  const adoption = async (id: string) => (await get(s, id)).adoption!;
  try {
    await web1.resolve("ref://prod/search");
    await settle(engine, 1);
    // Impact names who Resolver observed resolving, next to the declared consumers.
    const change = await proposeAndApprove(s, engine);
    const proposed = await get(s, change.id);
    assert.ok(proposed.impact.observedConsumers?.some((c) => c.instance === "web-1" && c.resolvedRevision === 1), JSON.stringify(proposed.impact.observedConsumers));
    assert.ok(proposed.impact.warnings.some((w) => /Observed but not declared here: search-frontend/.test(w)), proposed.impact.warnings.join(" | "));
    // Before this application has written anything, its own reads are still not counted as consumption.
    assert.ok(!proposed.impact.observedConsumers?.some((c) => c.principal === s.resolver.executorPrincipal || c.application === "resolver-control"), JSON.stringify(proposed.impact.observedConsumers));
    await engine.tick();
    assert.equal((await get(s, change.id)).status, "verified");
    // Committed and available, but nobody has fetched it yet: the stream invalidated web-1's cache, nothing more.
    await engine.tick();
    let state = await adoption(change.id);
    assert.equal(state.available.current, true);
    assert.equal(state.fetched.length, 0, "a notification is not a fetch");
    assert.deepEqual(state.notYetFetched.map((c) => c.instance).sort(), ["web-1", "web-2"]);
    // web-1 serves its next request: it resolves revision 2. web-2 never resolves.
    assert.equal((await web1.resolve("ref://prod/search")).revision, 2);
    await engine.tick();
    state = await adoption(change.id);
    assert.equal(state.revision, 2);
    assert.equal(state.authorized.mode, "authorized");
    assert.equal(state.authorized.jti, `${change.id}.1`);
    assert.deepEqual(state.fetched.map((c) => c.instance), ["web-1"]);
    assert.deepEqual(state.notYetFetched.map((c) => c.instance), ["web-2"]);
    assert.equal(state.adopted.length, 0, "fetching is not adopting");
    assert.equal(state.functionallyVerified, null);
    // web-1 reports using revision 2 successfully: adopted (asserted).
    await web1.report("ref://prod/search", 2, "succeeded");
    await engine.tick();
    state = await adoption(change.id);
    assert.deepEqual(state.adopted.map((c) => [c.instance, c.usedRevision, c.usedOutcome]), [["web-1", 2, "succeeded"]]);
    const types = (await s.t.as("ada").query(api.activity.list, { subjectId: change.id })).map((e) => e.type);
    assert.equal(types.filter((x) => x === "change.revision_fetched").length, 1, "recorded once, not on every refresh");
    assert.equal(types.filter((x) => x === "change.revision_adopted").length, 1);
    // A further revision of the reference keeps the consumer facts read before it (they are read on their own cadence).
    await engine.tick();
    const detail = await s.t.as("ada").query(api.catalog.detail, { ref: "ref://prod/search" });
    assert.deepEqual(detail.observation?.observedConsumers?.map((c) => c.instance).sort(), ["web-1", "web-2"]);
  } finally {
    await web1.close();
    await web2.close();
    await teardown(s, engine);
  }
});

test("consumer facts survive a new revision of the reference (they are read on their own cadence)", async () => {
  const s = await setup();
  const engine = engineFor(s.t, s.resolver, { signerToken: s.token, consumersIntervalMs: 60 * 60_000 });
  const web = await ResolverClient.connect({ url: s.resolver.url, apiKey: s.resolver.consumerKey, live: false, consumer: { application: "search-frontend", environment: "prod", instance: "web-1", dependencies: ["ref://prod/search"] } });
  try {
    await web.resolve("ref://prod/search");
    await engine.tick(); // observes, then reads consumer facts (the first read is immediate)
    const before = await s.t.as("ada").query(api.catalog.detail, { ref: "ref://prod/search" });
    assert.ok(before.observation?.observedConsumers?.some((c) => c.instance === "web-1"));
    await s.r.put(s.operator, { ref: "ref://prod/search", binding: searchB, expectedRevision: 1, reason: "outage", breakGlass: { reason: "provider A down" } });
    await engine.tick(); // observes revision 2; consumer facts are not due for an hour
    const after = await s.t.as("ada").query(api.catalog.detail, { ref: "ref://prod/search" });
    assert.equal(after.observation?.revision, 2);
    assert.ok(after.observation?.observedConsumers?.some((c) => c.instance === "web-1"), "kept across the new revision");
  } finally {
    await web.close();
    await teardown(s, engine);
  }
});

test("the signer core signs only claims derived from the record (unit, no network)", async () => {
  const key = generateSigningKey();
  const change = { id: "c1", number: 1, ref: "ref://prod/x", environment: "prod", kind: "endpoint", operation: "retarget" as const, binding: { value: { url: "https://b.example.com" } }, basedOnRevision: 4, status: "executing", validation: { passed: true }, approvals: [{ by: "linus", at: 1 }], execution: { attempt: 2, claimedBy: "component:resolver", claimedAt: Date.now() }, proposedBy: "grace" };
  const signer = createSigner({ privateKey: key.privateKeyPem, kid: "k", issuer: ISSUER, tenant: "acme", scope: ["ref://prod/*"], executor: "component:resolver", minApprovals: 1, validitySeconds: 60, maxClaimAgeMs: 60_000, reader: { change: async () => ({ change, policy: { frozen: false }, requiredApprovals: 1 }), events: async () => [{ type: "change.approval_recorded", actor: "linus", actorType: "user", subjectId: "c1" }] } });
  const ok = await signer.sign({ changeId: "c1", attempt: 2 });
  assert.ok(ok.ok);
  assert.equal(publicKeyOf(key.privateKeyPem), key.publicKey);
  const stale = await signer.sign({ changeId: "c1", attempt: 1 });
  assert.equal(!stale.ok && stale.reason, "signer.attempt-mismatch");
  change.execution.claimedAt = Date.now() - 120_000;
  const old = await signer.sign({ changeId: "c1", attempt: 2 });
  assert.equal(!old.ok && old.reason, "signer.claim-expired");
  const secret = { ...change, kind: "secret", execution: { ...change.execution, claimedAt: Date.now() } };
  const s2 = createSigner({ privateKey: key.privateKeyPem, kid: "k", issuer: ISSUER, tenant: "acme", scope: ["*"], executor: "component:resolver", minApprovals: 1, validitySeconds: 60, maxClaimAgeMs: 60_000, reader: { change: async () => ({ change: secret, policy: { frozen: false }, requiredApprovals: 1 }), events: async () => [{ type: "change.approval_recorded", actor: "linus", actorType: "user", subjectId: "c1" }] } });
  const refused = await s2.sign({ changeId: "c1", attempt: 2 });
  assert.equal(!refused.ok && refused.reason, "signer.unsigned-operation");
});
