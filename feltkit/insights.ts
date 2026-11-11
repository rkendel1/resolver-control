/**
 * Deterministic findings from the state this application holds. No model. Each finding names
 * its basis: observed (from Resolver), declared (by people or consumers) or derived (a rule over
 * both). Nothing is estimated or invented: where the data does not exist, the finding says so.
 */
import { s } from "@feltdb/feltkit";
import { app, candidates, changes, consumers, dependencies, events, observations, policies, settings, syncStatus } from "./app.js";
import { CORRELATION_PREFIX, describeBinding, effectivePolicy, type WeightedTarget } from "./_rules.js";

const Finding = s.object({
  id: s.string(),
  severity: s.enum(["action", "warning", "info"]),
  basis: s.enum(["observed", "declared", "derived"]),
  title: s.string(),
  detail: s.string(),
  ref: s.optional(s.string()),
  changeId: s.optional(s.string()),
});

export const findings = app.query({
  access: "insights.read",
  returns: s.array(Finding),
  capability: { name: "insights.list", description: "Deterministic findings: ungoverned or unowned dependencies, critical ones without fallback, missing consumers, environment drift, changes made outside governance, credentials in trouble, stale proposals." },
  handler: async (ctx) => {
    const [observed, catalogued, declared, open, stored] = await Promise.all([
      ctx.db.find(observations, {}),
      ctx.db.find(dependencies, {}),
      ctx.db.find(consumers, {}),
      ctx.db.find(changes, { status: "ready" }),
      ctx.db.find(policies, {}),
    ]);
    const out: Array<{ id: string; severity: "action" | "warning" | "info"; basis: "observed" | "declared" | "derived"; title: string; detail: string; ref?: string; changeId?: string }> = [];
    const meta = new Map(catalogued.map((d) => [d.ref, d]));
    const visible = observed.filter((o) => o.visible);
    const byRef = new Map(observed.map((o) => [o.ref, o]));

    for (const o of visible) {
      const d = meta.get(o.ref);
      if (!d) out.push({ id: `unregistered:${o.ref}`, severity: "warning", basis: "observed", title: "Not governed", detail: `${o.ref} resolves in Resolver (${o.kind}, r${o.revision}) but nobody has recorded its owner, criticality or change class.`, ref: o.ref });
      else {
        if (!d.owner) out.push({ id: `owner:${o.ref}`, severity: "warning", basis: "declared", title: "No owner", detail: `${d.title} has no recorded owner.`, ref: o.ref });
        if ((d.criticality === "critical" || d.criticality === "high") && (o.strategy ?? "single") === "single" && o.kind !== "secret" && o.kind !== "value") {
          out.push({ id: `fallback:${o.ref}`, severity: d.criticality === "critical" ? "action" : "warning", basis: "derived", title: "No fallback", detail: `${d.title} is ${d.criticality} and resolves to a single target (${describeBinding(o.kind, o.strategy, o.targets as WeightedTarget[])}). A failover binding would let consumers using withFailover survive its outage.`, ref: o.ref });
        }
        if (d.changeClass === "unknown") out.push({ id: `class:${o.ref}`, severity: "info", basis: "declared", title: "Change cost unassessed", detail: `Nobody has assessed whether ${d.title} can be switched at runtime, needs an adapter, or needs a migration.`, ref: o.ref });
      }
      if (o.kind !== "secret" && !declared.some((c) => c.ref === o.ref)) out.push({ id: `consumers:${o.ref}`, severity: "info", basis: "declared", title: "No known consumers", detail: `No application is declared as resolving ${o.ref}. Resolver does not report consumers, so the blast radius of a change is unknown until one is declared.`, ref: o.ref });
      for (const credential of o.credentialRefs) {
        const c = byRef.get(credential);
        if (!c) out.push({ id: `cred-missing:${o.ref}:${credential}`, severity: "warning", basis: "observed", title: "Credential not visible", detail: `${o.ref} names ${credential}, which the executor key has not observed (missing, or no read grant).`, ref: o.ref });
        else if (c.state === "revoked") out.push({ id: `cred-revoked:${o.ref}:${credential}`, severity: "action", basis: "observed", title: "Revoked credential in use", detail: `${o.ref} names ${credential}, which is revoked: every resolution that needs its key fails.`, ref: o.ref });
      }
      const outside = o.history.filter((h) => !(h.reason ?? "").includes(CORRELATION_PREFIX) && h.action !== "create");
      if (outside.length && meta.get(o.ref)) {
        const last = outside[0]!;
        out.push({ id: `out-of-band:${o.ref}:${last.revision}`, severity: "warning", basis: "observed", title: "Changed outside governance", detail: `Revision ${last.revision} of ${o.ref} was written directly in Resolver by ${last.actor}${last.reason ? ` ("${last.reason}")` : ""}, not through an approved change here.`, ref: o.ref });
      }
    }

    // Drift: the same path resolving differently in different environments.
    const paths = new Map<string, typeof visible>();
    for (const o of visible) paths.set(o.path, [...(paths.get(o.path) ?? []), o]);
    for (const [path, group] of paths) {
      if (group.length < 2 || group[0]!.kind === "secret") continue;
      const shapes = new Set(group.map((o) => describeBinding(o.kind, o.strategy, o.targets as WeightedTarget[]).replace(/ref:\/\/[a-z0-9._-]+\//g, "ref://*/")));
      if (shapes.size > 1) out.push({ id: `drift:${path}`, severity: "info", basis: "observed", title: "Environments differ", detail: `${path} resolves differently in ${group.map((o) => o.environment).sort().join(", ")}. Expected during a rollout; otherwise consider a promotion.` });
    }

    for (const change of open) {
      const o = byRef.get(change.ref);
      if (o && o.revision !== change.basedOnRevision) out.push({ id: `stale:${change.id}`, severity: "warning", basis: "derived", title: "Proposal is stale", detail: `CHG-${change.number} was proposed against r${change.basedOnRevision}; ${change.ref} is now at r${o.revision}.`, ref: change.ref, changeId: change.id });
    }
    for (const environment of new Set(visible.map((o) => o.environment))) {
      if (!effectivePolicy(environment, stored.find((p) => p.environment === environment)).explicit) {
        out.push({ id: `policy:${environment}`, severity: "info", basis: "derived", title: "No policy recorded", detail: `${environment} has no recorded change policy and is treated as protected with one approval.` });
      }
    }
    const order = { action: 0, warning: 1, info: 2 };
    return out.sort((a, b) => order[a.severity] - order[b.severity] || (a.id < b.id ? -1 : 1));
  },
});

export const overview = app.query({
  access: "insights.read",
  returns: s.object({
    configured: s.boolean(),
    sync: s.nullable(s.object({ state: s.string(), at: s.number(), detail: s.optional(s.string()), references: s.integer() })),
    references: s.integer(),
    governed: s.integer(),
    byKind: s.record(s.integer()),
    byEnvironment: s.record(s.integer()),
    changes: s.record(s.integer()),
    awaitingApproval: s.integer(),
    executedLast7Days: s.integer(),
    outOfBandLast7Days: s.integer(),
    openCandidates: s.integer(),
    recent: s.array(s.object({ id: s.string(), type: s.string(), ref: s.optional(s.string()), actor: s.string(), at: s.number() })),
  }),
  capability: { name: "insights.overview", description: "Counts from recorded state: references by kind and environment, changes by status, what awaits approval, recent activity." },
  handler: async (ctx) => {
    const weekAgo = Date.now() - 7 * 24 * 3600 * 1000;
    const [config, sync, observed, catalogued, all, recent, open] = await Promise.all([
      ctx.db.find(settings, {}, { limit: 1 }),
      ctx.db.find(syncStatus, {}, { limit: 1 }),
      ctx.db.find(observations, { visible: true }),
      ctx.db.find(dependencies, {}),
      ctx.db.find(changes, {}),
      ctx.db.find(events, {}, { orderBy: [{ field: "at", direction: "desc" }], limit: 12 }),
      ctx.db.count(candidates, { status: "open" }),
    ]);
    const count = <T>(items: T[], key: (item: T) => string) => items.reduce<Record<string, number>>((acc, item) => ((acc[key(item)] = (acc[key(item)] ?? 0) + 1), acc), {});
    const governedRefs = new Set(catalogued.map((d) => d.ref));
    const s0 = sync[0];
    return {
      configured: config.length > 0,
      sync: s0 ? { state: s0.state, at: s0.at, references: s0.references, ...(s0.detail ? { detail: s0.detail } : {}) } : null,
      references: observed.length,
      governed: observed.filter((o) => governedRefs.has(o.ref)).length,
      byKind: count(observed, (o) => o.kind),
      byEnvironment: count(observed, (o) => o.environment),
      changes: count(all, (c) => c.status),
      awaitingApproval: all.filter((c) => c.status === "ready").length,
      executedLast7Days: all.filter((c) => c.status === "verified" && (c.execution?.finishedAt ?? 0) > weekAgo).length,
      outOfBandLast7Days: (await ctx.db.find(events, { type: "resolver.change.out_of_band" })).filter((e) => e.at > weekAgo).length,
      openCandidates: open,
      recent: recent.map((e) => ({ id: e.id, type: e.type, actor: e.actor, at: e.at, ...(e.ref ? { ref: e.ref } : {}) })),
    };
  },
});
