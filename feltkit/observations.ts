/**
 * The projection of Resolver, written only by the resolver component (`observations.write`).
 * Every write is stamped with the revision Resolver answered and the time it was read. Nothing
 * here is used as authority for a write: execution is conditional on the revision a change was
 * based on, and Resolver checks it.
 */
import { s } from "@feltdb/feltkit";
import { app, Governance, KINDS, ObservedConsumer, observations } from "./app.js";
import { record } from "./_audit.js";
import { CORRELATION_PREFIX, credentialRefs, parseRef, type WeightedTarget } from "./_rules.js";

const Entry = s.object({
  revision: s.integer(),
  action: s.string(),
  strategy: s.optional(s.string()),
  targets: s.optional(s.array(s.unknown())),
  actor: s.string(),
  reason: s.optional(s.string()),
  at: s.string(),
  restoredFrom: s.optional(s.integer()),
  governance: s.optional(Governance),
});

const Observed = s.object({
  ref: s.string(),
  kind: s.enum(KINDS),
  revision: s.integer({ minimum: 0 }),
  state: s.enum(["active", "revoked"]),
  updatedAt: s.string(),
  strategy: s.optional(s.string()),
  targets: s.array(s.unknown()),
  ttlSeconds: s.optional(s.integer()),
  history: s.array(Entry),
});

/** What the projection holds, so the component reads Resolver only for references that moved. */
export const index = app.query({
  access: "observations.write",
  returns: s.array(s.object({ ref: s.string(), revision: s.integer(), state: s.string(), visible: s.boolean() })),
  handler: async (ctx) => (await ctx.db.find(observations, {})).map((o) => ({ ref: o.ref, revision: o.revision, state: o.state, visible: o.visible })),
});

export const upsert = app.mutation({
  access: "observations.write",
  args: { items: s.array(Observed, { maxItems: 50 }) },
  returns: s.object({ written: s.integer(), outOfBand: s.integer() }),
  handler: async (ctx, { items }) => {
    let outOfBand = 0;
    for (const item of items) {
      const parts = parseRef(item.ref);
      if ("error" in parts) continue;
      const existing = (await ctx.db.find(observations, { ref: item.ref }, { limit: 1 }))[0];
      const fields = {
        ...item,
        environment: parts.environment,
        path: parts.path,
        credentialRefs: credentialRefs(item.kind, item.targets as WeightedTarget[]),
        visible: true,
        observedAt: Date.now(),
      };
      // Consumer facts are read separately (recordConsumers): a new revision does not erase them.
      if (existing) await ctx.db.replace(observations, existing.id, { ...fields, ...(existing.observedConsumers ? { observedConsumers: existing.observedConsumers, consumersObservedAt: existing.consumersObservedAt } : {}) });
      else await ctx.db.insert(observations, fields);
      // Revisions written since the last observation that this application did not write: a change
      // made directly in Resolver (its CLI, its pages, another tool). Recorded, never hidden.
      // The first sighting establishes the baseline: history from before governance is not reported.
      if (!existing) continue;
      for (const entry of item.history) {
        if (entry.revision <= existing.revision) continue;
        const ours = typeof entry.reason === "string" && entry.reason.includes(CORRELATION_PREFIX);
        if (!ours) {
          outOfBand += 1;
          await record(ctx, "dependency", item.ref, "resolver.change.out_of_band", { revision: entry.revision, action: entry.action, resolverActor: entry.actor, reason: entry.reason ?? null, at: entry.at, governance: entry.governance?.mode ?? "ungoverned" });
        }
        // Resolver records operator break-glass on the revision itself: surfaced as its own event, whoever wrote it.
        if (entry.governance?.mode === "break-glass") {
          await record(ctx, "dependency", item.ref, "resolver.change.break_glass", { revision: entry.revision, action: entry.action, operator: entry.governance.actor ?? entry.actor, reason: entry.governance.reason ?? null, at: entry.at });
        }
      }
    }
    return { written: items.length, outOfBand };
  },
});

/** Resolver's consumer facts for references (Resolver 0.4.0 `resolver.consumers.list`): a projection, replaced on each read. */
export const recordConsumers = app.mutation({
  access: "observations.write",
  args: { items: s.array(s.object({ ref: s.string(), consumers: s.array(ObservedConsumer, { maxItems: 200 }) }), { maxItems: 50 }) },
  handler: async (ctx, { items }) => {
    const at = Date.now();
    for (const item of items) {
      const existing = (await ctx.db.find(observations, { ref: item.ref }, { limit: 1 }))[0];
      if (existing) await ctx.db.patch(observations, existing.id, { observedConsumers: item.consumers, consumersObservedAt: at });
    }
    return null;
  },
});

/** References the executor key no longer sees (a removed grant): kept, marked invisible, never deleted. */
export const hide = app.mutation({
  access: "observations.write",
  args: { refs: s.array(s.string(), { maxItems: 200 }) },
  handler: async (ctx, { refs }) => {
    for (const ref of refs) {
      const existing = (await ctx.db.find(observations, { ref }, { limit: 1 }))[0];
      if (existing && existing.visible) {
        await ctx.db.patch(observations, existing.id, { visible: false, observedAt: Date.now() });
        await record(ctx, "dependency", ref, "resolver.reference.not_visible", { lastRevision: existing.revision });
      }
    }
    return null;
  },
});
