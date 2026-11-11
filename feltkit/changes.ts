/**
 * The change lifecycle.
 *
 *   proposed ──validation──▶ ready ──approvals──▶ approved ──claim──▶ executing ──▶ verified
 *       │                      │                     │                    ├──▶ failed      (Resolver refused; nothing changed)
 *       ├──▶ invalid           ├──▶ rejected         ├──▶ rejected        ├──▶ superseded  (the reference moved since the proposal)
 *       └──▶ superseded        └──▶ cancelled        └──▶ cancelled       └──▶ unknown     (outcome not determined: reconciled from Resolver's history)
 *
 * A proposal never becomes an execution by itself: only the resolver component executes, only
 * `approved` changes, only while the environment is not frozen and the approvals still meet the
 * policy. Every Resolver write is conditional on the revision the change was based on, and
 * carries the change's correlation tag in its reason, so Resolver's own history names the change.
 */
import { fail, s, type MutationCtx, type QueryCtx } from "@feltdb/feltkit";
import { app, changes, Check, consumers, dependencies, KINDS, observations, policies } from "./app.js";
import { record } from "./_audit.js";
import { bindingTargets, computeImpact, effectivePolicy, parseRef, refIn, requiredApprovals, type WeightedTarget } from "./_rules.js";

const Change = s.doc(changes);
const OPEN = ["proposed", "ready", "approved", "executing", "unknown"] as const;
/** How long an execution claim is honoured before the component reconciles it from Resolver's history. */
export const LEASE_MS = 60_000;

type Ctx = QueryCtx | MutationCtx;

async function observed(ctx: Ctx, ref: string) {
  return (await ctx.db.find(observations, { ref }, { limit: 1 }))[0] ?? null;
}

async function policyFor(ctx: Ctx, environment: string) {
  return effectivePolicy(environment, (await ctx.db.find(policies, { environment }, { limit: 1 }))[0]);
}

async function openChangeFor(ctx: Ctx, ref: string) {
  for (const status of OPEN) {
    const found = (await ctx.db.find(changes, { ref, status }, { limit: 1 }))[0];
    if (found) return found;
  }
  return null;
}

async function load(ctx: Ctx, id: string) {
  const change = await ctx.db.get(changes, id);
  if (!change) fail("NOT_FOUND", `No change ${id}.`);
  return change;
}

interface Proposal {
  ref: string;
  operation: "create" | "retarget" | "rollback";
  kind?: (typeof KINDS)[number];
  binding?: unknown;
  toRevision?: number;
  basedOnRevision: number;
  reason: string;
  ttlSeconds?: number;
  revertOf?: string;
  promotedFrom?: { ref: string; revision: number };
}

async function propose(ctx: MutationCtx, p: Proposal) {
  const who = ctx.auth.requirePrincipal();
  const parts = parseRef(p.ref);
  if ("error" in parts) fail("INVALID_ARGUMENT", parts.error);
  const current = await observed(ctx, p.ref);
  const open = await openChangeFor(ctx, p.ref);
  if (open) fail("FAILED_PRECONDITION", `CHG-${open.number} is already open for ${p.ref} (${open.status}). Decide or cancel it first.`);

  let kind: (typeof KINDS)[number];
  if (p.operation === "create") {
    if (current) fail("FAILED_PRECONDITION", `${p.ref} already exists in Resolver (revision ${current.revision}); propose a retarget instead.`);
    if (!p.kind) fail("INVALID_ARGUMENT", "A new reference needs a kind.");
    if (p.basedOnRevision !== 0) fail("INVALID_ARGUMENT", "A new reference is based on revision 0.");
    kind = p.kind;
  } else {
    if (!current || !current.visible) fail("FAILED_PRECONDITION", `${p.ref} has not been observed in Resolver. Wait for the resolver component to synchronize, or check its grants.`);
    if (current.state === "revoked") fail("FAILED_PRECONDITION", `${p.ref} is revoked in Resolver; a revoked name is never reused.`);
    if (p.kind && p.kind !== current.kind) fail("INVALID_ARGUMENT", `${p.ref} is a ${current.kind}; a reference's kind never changes.`);
    if (p.basedOnRevision !== current.revision) {
      fail("FAILED_PRECONDITION", `${p.ref} is at revision ${current.revision} (observed), not ${p.basedOnRevision}. Review the current resolution and propose again.`);
    }
    kind = current.kind;
  }
  if (kind === "secret" && p.operation !== "rollback") {
    fail("FAILED_PRECONDITION", "Secret material is never handled by this application. Set or rotate it in Resolver (its Secrets page or `resolver set --secret-stdin`); this application can propose rolling a secret back to an earlier revision.");
  }
  if (p.operation === "rollback") {
    if (!p.toRevision || p.toRevision >= (current?.revision ?? 0)) fail("INVALID_ARGUMENT", `Roll back to an earlier revision than ${current?.revision ?? 0}.`);
  } else if (!bindingTargets(p.binding)) {
    fail("INVALID_ARGUMENT", "A binding is { value } or { strategy, targets }.");
  }
  if (p.ttlSeconds !== undefined && p.operation === "rollback") fail("INVALID_ARGUMENT", "A rollback restores a revision as recorded; it takes no TTL.");

  const dependency = (await ctx.db.find(dependencies, { ref: p.ref }, { limit: 1 }))[0] ?? null;
  const policy = await policyFor(ctx, parts.environment);
  const declared = await ctx.db.find(consumers, { ref: p.ref });
  const dependents = kind === "secret" ? (await ctx.db.find(observations, {})).filter((o) => o.credentialRefs.includes(p.ref)).map((o) => o.ref) : [];
  const restored = p.operation === "rollback" ? current?.history.find((h) => h.revision === p.toRevision) : undefined;
  const next = p.operation === "rollback" ? (restored?.targets ? { strategy: restored.strategy ?? "single", targets: restored.targets as WeightedTarget[] } : null) : bindingTargets(p.binding);
  const impact = computeImpact({
    ref: p.ref,
    kind,
    operation: p.operation,
    policy,
    dependency,
    current: current ? { revision: current.revision, strategy: current.strategy, targets: current.targets as WeightedTarget[], ttlSeconds: current.ttlSeconds, observedAt: current.observedAt } : null,
    next,
    consumers: declared,
    dependents,
    now: Date.now(),
  });
  if (p.operation === "rollback" && !restored) impact.unknowns.unshift(`Revision ${p.toRevision} is older than the history observed here; Resolver checks it exists when the rollback executes.`);
  // A binding that names a reference in another environment crosses the environment boundary.
  const crossing = JSON.stringify(p.binding ?? null).match(/ref:\/\/[a-z0-9._-]+\//g)?.filter((r) => r !== `ref://${parts.environment}/`) ?? [];
  if (crossing.length) impact.warnings.unshift(`The binding names references outside ${parts.environment} (${[...new Set(crossing)].join(", ")}). Validation refuses it.`);

  const number = await ctx.db.sequence("changes");
  const now = Date.now();
  const id = await ctx.db.insert(changes, {
    number,
    ref: p.ref,
    environment: parts.environment,
    kind,
    operation: p.operation,
    ...(p.binding !== undefined ? { binding: p.binding } : {}),
    ...(p.toRevision ? { toRevision: p.toRevision } : {}),
    basedOnRevision: p.basedOnRevision,
    basedOnTargets: current?.targets ?? [],
    ...(current?.strategy ? { basedOnStrategy: current.strategy } : {}),
    ...(p.ttlSeconds !== undefined ? { ttlSeconds: p.ttlSeconds } : {}),
    reason: p.reason,
    status: "proposed",
    impact,
    approvals: [],
    ...(p.revertOf ? { revertOf: p.revertOf } : {}),
    ...(p.promotedFrom ? { promotedFrom: p.promotedFrom } : {}),
    proposedBy: who.id,
    proposedByType: who.type,
    proposedAt: now,
    updatedAt: now,
  });
  await record(ctx, "change", id, "change.proposed", { number, operation: p.operation, basedOnRevision: p.basedOnRevision, reason: p.reason, requiredApprovals: impact.requiredApprovals }, p.ref);
  return (await ctx.db.get(changes, id))!;
}

const proposalArgs = { reason: s.string({ minLength: 3, maxLength: 1000 }) };

export const proposeRetarget = app.mutation({
  access: "changes.propose",
  args: { ref: s.string(), binding: s.unknown(), basedOnRevision: s.integer({ minimum: 1 }), ttlSeconds: s.optional(s.integer({ minimum: 0, maximum: 86400 })), ...proposalArgs },
  returns: Change,
  capability: { name: "changes.propose", description: "Propose changing what a reference resolves to: a binding { value } or { strategy: single|weighted|failover, targets }. Based on the revision you inspected; nothing changes until it is validated, approved by people and executed." },
  handler: (ctx, { ref, binding, basedOnRevision, ttlSeconds, reason }) => propose(ctx, { ref, operation: "retarget", binding, basedOnRevision, reason, ...(ttlSeconds !== undefined ? { ttlSeconds } : {}) }),
});

export const proposeCreate = app.mutation({
  access: "changes.propose",
  args: { ref: s.string(), kind: s.enum(["value", "model", "endpoint", "agent"]), binding: s.unknown(), ttlSeconds: s.optional(s.integer({ minimum: 0, maximum: 86400 })), ...proposalArgs },
  returns: Change,
  capability: { name: "changes.introduce", description: "Propose introducing a new runtime reference (value, model, endpoint or agent). Secrets are created in Resolver directly." },
  handler: (ctx, { ref, kind, binding, ttlSeconds, reason }) => propose(ctx, { ref, operation: "create", kind, binding, basedOnRevision: 0, reason, ...(ttlSeconds !== undefined ? { ttlSeconds } : {}) }),
});

export const proposeRollback = app.mutation({
  access: "changes.propose",
  args: { ref: s.string(), toRevision: s.integer({ minimum: 1 }), basedOnRevision: s.integer({ minimum: 1 }), ...proposalArgs },
  returns: Change,
  capability: { name: "changes.rollback", description: "Propose restoring the binding a reference had at an earlier revision. A rollback is a new change with its own approval and evidence; history is never erased." },
  handler: (ctx, { ref, toRevision, basedOnRevision, reason }) => propose(ctx, { ref, operation: "rollback", toRevision, basedOnRevision, reason }),
});

export const proposeRevert = app.mutation({
  access: "changes.propose",
  args: { id: s.string(), ...proposalArgs },
  returns: Change,
  capability: { name: "changes.revert", description: "Propose undoing a verified change: a rollback to the revision it was based on, as the reference stands now." },
  handler: async (ctx, { id, reason }) => {
    const change = await load(ctx, id);
    if (change.status !== "verified") fail("FAILED_PRECONDITION", `CHG-${change.number} is ${change.status}; only a verified change can be reverted.`);
    if (change.basedOnRevision < 1) fail("FAILED_PRECONDITION", `CHG-${change.number} created ${change.ref}; there is no earlier revision to restore. Revoke it in Resolver if it must go.`);
    const current = await observed(ctx, change.ref);
    if (!current) fail("FAILED_PRECONDITION", `${change.ref} is not observed.`);
    return propose(ctx, { ref: change.ref, operation: "rollback", toRevision: change.basedOnRevision, basedOnRevision: current.revision, reason, revertOf: change.id });
  },
});

export const proposePromotion = app.mutation({
  access: "changes.propose",
  args: { from: s.string(), toEnvironment: s.string(), ...proposalArgs },
  returns: Change,
  capability: { name: "changes.promote", description: "Propose giving the same reference path in another environment the binding it has here (e.g. staging → prod). References inside the binding must be environment-neutral or validation refuses it." },
  handler: async (ctx, { from, toEnvironment, reason }) => {
    const source = await observed(ctx, from);
    if (!source || !source.visible || source.state !== "active") fail("FAILED_PRECONDITION", `${from} is not an active observed reference.`);
    if (source.kind === "secret") fail("FAILED_PRECONDITION", "Secrets are not promoted: each environment holds its own material in Resolver.");
    if (source.environment === toEnvironment) fail("INVALID_ARGUMENT", "Promote to a different environment.");
    const target = refIn(toEnvironment, source.path);
    const existing = await observed(ctx, target);
    const binding = { strategy: source.strategy ?? "single", targets: source.targets };
    const promotedFrom = { ref: from, revision: source.revision };
    if (existing && existing.kind !== source.kind) fail("FAILED_PRECONDITION", `${target} is a ${existing.kind}, ${from} a ${source.kind}.`);
    return existing
      ? propose(ctx, { ref: target, operation: "retarget", binding, basedOnRevision: existing.revision, reason, promotedFrom })
      : propose(ctx, { ref: target, operation: "create", kind: source.kind, binding, basedOnRevision: 0, reason, promotedFrom });
  },
});

export const list = app.query({
  access: "changes.read",
  args: { status: s.optional(s.string()), environment: s.optional(s.string()), ref: s.optional(s.string()), limit: s.optional(s.integer({ minimum: 1, maximum: 500 })) },
  returns: s.array(Change),
  capability: { name: "changes.list", description: "Changes, newest first, by status, environment or reference." },
  handler: async (ctx, { status, environment, ref, limit }) => {
    const filter = { ...(status ? { status } : {}), ...(environment ? { environment } : {}), ...(ref ? { ref } : {}) };
    return ctx.db.find(changes, filter as never, { orderBy: [{ field: "number", direction: "desc" }], limit: limit ?? 200 });
  },
});

export const get = app.query({
  access: "changes.read",
  args: { id: s.string() },
  returns: s.object({ change: Change, policy: s.object({ protected: s.boolean(), approvalsRequired: s.integer(), frozen: s.boolean(), explicit: s.boolean() }), requiredApprovals: s.integer(), currentRevision: s.nullable(s.integer()) }),
  capability: { name: "changes.inspect", description: "One change: proposal, impact, validation, approvals, execution and verification evidence, with the policy that applies now." },
  handler: async (ctx, { id }) => {
    const change = await load(ctx, id);
    const policy = await policyFor(ctx, change.environment);
    const dependency = (await ctx.db.find(dependencies, { ref: change.ref }, { limit: 1 }))[0];
    const current = await observed(ctx, change.ref);
    return {
      change,
      policy: { protected: policy.protected, approvalsRequired: policy.approvalsRequired, frozen: policy.frozen, explicit: policy.explicit },
      requiredApprovals: requiredApprovals(policy, dependency?.criticality ?? "medium"),
      currentRevision: current?.revision ?? null,
    };
  },
});

export const approve = app.mutation({
  access: "changes.approve",
  args: { id: s.string(), note: s.optional(s.string({ maxLength: 1000 })) },
  returns: Change,
  capability: { name: "changes.approve", description: "Approve a validated change. Only a person, never its proposer, never twice; protected environments need changes.approve.protected; frozen environments refuse." },
  handler: async (ctx, { id, note }) => {
    const who = ctx.auth.requirePrincipal();
    const change = await load(ctx, id);
    if (who.type !== "user") fail("FORBIDDEN", "Only a person may approve a change.");
    if (change.status !== "ready") fail("FAILED_PRECONDITION", `CHG-${change.number} is ${change.status}; only a validated change awaiting approval can be approved.`);
    if (change.proposedBy === who.id) fail("FORBIDDEN", "The proposer of a change may not approve it.");
    if (change.approvals.some((a) => a.by === who.id)) fail("FAILED_PRECONDITION", `You already approved CHG-${change.number}; another person must.`);
    const policy = await policyFor(ctx, change.environment);
    if (policy.protected && !ctx.auth.has("changes.approve.protected")) fail("FORBIDDEN", `${change.environment} is protected: approving needs changes.approve.protected.`);
    if (policy.frozen) fail("FAILED_PRECONDITION", `${change.environment} is frozen${policy.freezeReason ? `: ${policy.freezeReason}` : ""}.`);
    const current = await observed(ctx, change.ref);
    if (current && current.revision !== change.basedOnRevision) {
      fail("FAILED_PRECONDITION", `${change.ref} moved to revision ${current.revision} since CHG-${change.number} was proposed at ${change.basedOnRevision}. The resolver component marks it superseded; propose again against the current resolution.`);
    }
    const dependency = (await ctx.db.find(dependencies, { ref: change.ref }, { limit: 1 }))[0];
    const required = requiredApprovals(policy, dependency?.criticality ?? "medium");
    const approvals = [...change.approvals, { by: who.id, at: Date.now(), ...(note ? { note } : {}) }];
    const status = approvals.length >= required ? "approved" : "ready";
    await ctx.db.patch(changes, id, { approvals, status, updatedAt: Date.now() });
    await record(ctx, "change", id, "change.approval_recorded", { number: change.number, approvals: approvals.length, required, note: note ?? null }, change.ref);
    if (status === "approved") await record(ctx, "change", id, "change.approved", { number: change.number, approvers: approvals.map((a) => a.by) }, change.ref);
    return (await ctx.db.get(changes, id))!;
  },
});

export const reject = app.mutation({
  access: "changes.approve",
  args: { id: s.string(), note: s.string({ minLength: 3, maxLength: 1000 }) },
  returns: Change,
  capability: { name: "changes.reject", description: "Reject a change before it executes, with a reason." },
  handler: async (ctx, { id, note }) => {
    const who = ctx.auth.requirePrincipal();
    if (who.type !== "user") fail("FORBIDDEN", "Only a person may reject a change.");
    const change = await load(ctx, id);
    if (!["proposed", "ready", "approved"].includes(change.status)) fail("FAILED_PRECONDITION", `CHG-${change.number} is ${change.status}.`);
    await ctx.db.patch(changes, id, { status: "rejected", decision: { outcome: "rejected", by: who.id, at: Date.now(), note }, updatedAt: Date.now() });
    await record(ctx, "change", id, "change.rejected", { number: change.number, note }, change.ref);
    return (await ctx.db.get(changes, id))!;
  },
});

export const cancel = app.mutation({
  access: "changes.cancel",
  args: { id: s.string(), note: s.optional(s.string({ maxLength: 1000 })) },
  returns: Change,
  capability: { name: "changes.cancel", description: "Withdraw your own change before it executes." },
  handler: async (ctx, { id, note }) => {
    const who = ctx.auth.requirePrincipal();
    const change = await load(ctx, id);
    if (change.proposedBy !== who.id) fail("FORBIDDEN", "Only the proposer may withdraw a change; others reject it.");
    if (!["proposed", "ready", "approved", "invalid"].includes(change.status)) fail("FAILED_PRECONDITION", `CHG-${change.number} is ${change.status}.`);
    await ctx.db.patch(changes, id, { status: "cancelled", decision: { outcome: "cancelled", by: who.id, at: Date.now(), ...(note ? { note } : {}) }, updatedAt: Date.now() });
    await record(ctx, "change", id, "change.cancelled", { number: change.number, note: note ?? null }, change.ref);
    return (await ctx.db.get(changes, id))!;
  },
});

// ---- the resolver component's side (changes.execute) ----------------------------------------------

/** What the component should do now: validate proposals, execute approved changes, reconcile unsettled ones. */
export const work = app.query({
  access: "changes.execute",
  returns: s.object({ validate: s.array(Change), execute: s.array(Change), reconcile: s.array(Change), stale: s.array(s.object({ id: s.string(), currentRevision: s.integer() })) }),
  handler: async (ctx) => {
    const now = Date.now();
    const approved = await ctx.db.find(changes, { status: "approved" }, { orderBy: [{ field: "number", direction: "asc" }] });
    const execute = [];
    for (const change of approved) {
      const policy = await policyFor(ctx, change.environment);
      if (!policy.frozen) execute.push(change);
    }
    const executing = await ctx.db.find(changes, { status: "executing" });
    // Awaiting approval, but the reference moved (per the latest observation): it can never execute as approved.
    const stale = [];
    for (const change of await ctx.db.find(changes, { status: "ready" })) {
      const current = await observed(ctx, change.ref);
      if (current && current.revision !== change.basedOnRevision) stale.push({ id: change.id, currentRevision: current.revision });
    }
    return {
      stale,
      validate: await ctx.db.find(changes, { status: "proposed" }, { orderBy: [{ field: "number", direction: "asc" }] }),
      execute,
      reconcile: [...executing.filter((c) => now - (c.execution?.claimedAt ?? 0) > LEASE_MS), ...(await ctx.db.find(changes, { status: "unknown" }))],
    };
  },
});

export const recordValidation = app.mutation({
  access: "changes.execute",
  args: { id: s.string(), checks: s.array(Check, { maxItems: 30 }), superseded: s.optional(s.object({ currentRevision: s.integer() })) },
  returns: Change,
  handler: async (ctx, { id, checks, superseded }) => {
    const who = ctx.auth.requirePrincipal();
    const change = await load(ctx, id);
    if (change.status !== "proposed") fail("FAILED_PRECONDITION", `CHG-${change.number} is ${change.status}, not awaiting validation.`);
    const passed = !checks.some((c) => c.outcome === "fail");
    const status = superseded ? "superseded" : passed ? "ready" : "invalid";
    await ctx.db.patch(changes, id, { status, validation: { at: Date.now(), by: who.id, passed, checks }, updatedAt: Date.now() });
    await record(ctx, "change", id, `change.${status === "ready" ? "validated" : status}`, { number: change.number, failed: checks.filter((c) => c.outcome === "fail").map((c) => c.id), deferred: checks.filter((c) => c.outcome === "deferred").map((c) => c.id), ...(superseded ? { currentRevision: superseded.currentRevision } : {}) }, change.ref);
    return (await ctx.db.get(changes, id))!;
  },
});

/** A change awaiting approval whose reference has moved since it was proposed. */
export const supersede = app.mutation({
  access: "changes.execute",
  args: { id: s.string(), currentRevision: s.integer() },
  returns: Change,
  handler: async (ctx, { id, currentRevision }) => {
    const change = await load(ctx, id);
    if (change.status !== "ready" || currentRevision === change.basedOnRevision) fail("FAILED_PRECONDITION", `CHG-${change.number} is ${change.status} at revision ${change.basedOnRevision}.`);
    await ctx.db.patch(changes, id, { status: "superseded", updatedAt: Date.now() });
    await record(ctx, "change", id, "change.superseded", { number: change.number, basedOnRevision: change.basedOnRevision, currentRevision }, change.ref);
    return (await ctx.db.get(changes, id))!;
  },
});

/** Take an approved (or unsettled) change for execution. Concurrent claims conflict at commit; only one wins. */
export const claim = app.mutation({
  access: "changes.execute",
  args: { id: s.string() },
  returns: Change,
  handler: async (ctx, { id }) => {
    const who = ctx.auth.requirePrincipal();
    const change = await load(ctx, id);
    const now = Date.now();
    const stale = change.status === "executing" && now - (change.execution?.claimedAt ?? 0) > LEASE_MS;
    if (change.status === "approved") {
      // Re-check authority at the moment of execution: policies may have tightened since approval.
      const policy = await policyFor(ctx, change.environment);
      if (policy.frozen) fail("FAILED_PRECONDITION", `${change.environment} is frozen; CHG-${change.number} waits.`);
      const dependency = (await ctx.db.find(dependencies, { ref: change.ref }, { limit: 1 }))[0];
      const required = requiredApprovals(policy, dependency?.criticality ?? "medium");
      if (change.approvals.length < required) {
        await ctx.db.patch(changes, id, { status: "ready", updatedAt: now });
        await record(ctx, "change", id, "change.needs_more_approvals", { number: change.number, approvals: change.approvals.length, required }, change.ref);
        return (await ctx.db.get(changes, id))!;
      }
    } else if (!stale && change.status !== "unknown") {
      fail("FAILED_PRECONDITION", `CHG-${change.number} is ${change.status}; nothing to execute.`);
    }
    const attempt = (change.execution?.attempt ?? 0) + 1;
    await ctx.db.patch(changes, id, { status: "executing", execution: { attempt, claimedBy: who.id, claimedAt: now }, updatedAt: now });
    await record(ctx, "change", id, change.status === "approved" ? "change.execution_started" : "change.reconciliation_started", { number: change.number, attempt, previous: change.status }, change.ref);
    return (await ctx.db.get(changes, id))!;
  },
});

const Verification = s.object({
  at: s.number(),
  passed: s.boolean(),
  revision: s.integer(),
  currentRevision: s.integer(),
  actor: s.optional(s.string()),
  correlated: s.boolean(),
  bindingMatches: s.boolean(),
  selected: s.optional(s.unknown()),
  checks: s.array(Check),
});

/** The outcome of an execution attempt, with Resolver's evidence. Fenced: only the current attempt may settle. */
export const settle = app.mutation({
  access: "changes.execute",
  args: {
    id: s.string(),
    attempt: s.integer({ minimum: 1 }),
    outcome: s.enum(["verified", "failed", "unknown", "superseded", "requeue"]),
    resolverRevision: s.optional(s.integer()),
    error: s.optional(s.object({ code: s.string(), reason: s.optional(s.string()), message: s.string() })),
    note: s.optional(s.string({ maxLength: 2000 })),
    verification: s.optional(Verification),
  },
  returns: Change,
  handler: async (ctx, { id, attempt, outcome, resolverRevision, error, note, verification }) => {
    const change = await load(ctx, id);
    if (change.status !== "executing" || change.execution?.attempt !== attempt) {
      fail("CONFLICT", `CHG-${change.number} is no longer held by attempt ${attempt} (${change.status}, attempt ${change.execution?.attempt ?? 0}).`);
    }
    if (outcome === "verified" && !verification?.passed) fail("INVALID_ARGUMENT", "A change is verified only with passing verification evidence.");
    const status = outcome === "requeue" ? "approved" : outcome;
    const execution = {
      ...change.execution!,
      finishedAt: Date.now(),
      ...(resolverRevision !== undefined ? { resolverRevision } : {}),
      ...(error ? { error } : {}),
      ...(note ? { note } : {}),
    };
    await ctx.db.patch(changes, id, { status, execution, ...(verification ? { verification } : {}), updatedAt: Date.now() });
    await record(ctx, "change", id, `change.${outcome === "requeue" ? "requeued" : outcome}`, {
      number: change.number,
      attempt,
      resolverRevision: resolverRevision ?? null,
      ...(error ? { error } : {}),
      ...(note ? { note } : {}),
      ...(verification ? { verified: verification.passed, correlated: verification.correlated, bindingMatches: verification.bindingMatches, currentRevision: verification.currentRevision } : {}),
    }, change.ref);
    return (await ctx.db.get(changes, id))!;
  },
});
