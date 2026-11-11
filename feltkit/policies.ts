import { fail, s } from "@feltdb/feltkit";
import { app, policies } from "./app.js";
import { record } from "./_audit.js";

const Policy = s.doc(policies);
const NAMESPACE = /^[a-z0-9](?:[a-z0-9._-]{0,62}[a-z0-9])?$/;

export const list = app.query({
  access: "policies.read",
  returns: s.array(Policy),
  capability: { name: "policies.list", description: "Recorded change policies per environment. An environment without one is treated as protected with one approval." },
  handler: (ctx) => ctx.db.find(policies, {}, { orderBy: [{ field: "environment", direction: "asc" }] }),
});

async function upsert(ctx: Parameters<typeof record>[0], environment: string, patch: { protected?: boolean; approvalsRequired?: number; frozen?: boolean; freezeReason?: string | undefined }) {
  const who = ctx.auth.requirePrincipal();
  if (who.type !== "user") fail("FORBIDDEN", "Only a person may change a change policy.");
  if (!NAMESPACE.test(environment)) fail("INVALID_ARGUMENT", `"${environment}" is not a reference namespace.`);
  const existing = (await ctx.db.find(policies, { environment }, { limit: 1 }))[0];
  const base = existing ?? { environment, protected: true, approvalsRequired: 1, frozen: false };
  const fields = {
    environment,
    protected: patch.protected ?? base.protected,
    approvalsRequired: patch.approvalsRequired ?? base.approvalsRequired,
    frozen: patch.frozen ?? base.frozen,
    ...((patch.frozen ?? base.frozen) && (patch.freezeReason ?? (existing as { freezeReason?: string } | undefined)?.freezeReason) ? { freezeReason: patch.freezeReason ?? (existing as { freezeReason?: string }).freezeReason } : {}),
    updatedBy: who.id,
    updatedAt: Date.now(),
  };
  const id = existing ? (await ctx.db.replace(policies, existing.id, fields)).id : await ctx.db.insert(policies, fields);
  return { id, existing, fields };
}

export const set = app.mutation({
  access: "policies.write",
  args: { environment: s.string(), protected: s.boolean(), approvalsRequired: s.integer({ minimum: 1, maximum: 5 }) },
  returns: Policy,
  capability: { name: "policies.set", description: "Set whether an environment is protected (approvals need changes.approve.protected) and how many distinct people must approve." },
  handler: async (ctx, { environment, protected: isProtected, approvalsRequired }) => {
    const { id, existing } = await upsert(ctx, environment, { protected: isProtected, approvalsRequired });
    await record(ctx, "policy", environment, "policy.changed", { protected: isProtected, approvalsRequired, previous: existing ? { protected: existing.protected, approvalsRequired: existing.approvalsRequired } : null });
    return (await ctx.db.get(policies, id))!;
  },
});

export const freeze = app.mutation({
  access: "policies.write",
  args: { environment: s.string(), frozen: s.boolean(), reason: s.optional(s.string({ maxLength: 500 })) },
  returns: Policy,
  capability: { name: "policies.freeze", description: "Freeze or unfreeze an environment. While frozen, no change is approved or executed there; approved changes wait." },
  handler: async (ctx, { environment, frozen, reason }) => {
    if (frozen && !reason) fail("INVALID_ARGUMENT", "Say why the environment is frozen.");
    const { id } = await upsert(ctx, environment, { frozen, freezeReason: frozen ? reason : undefined });
    await record(ctx, "policy", environment, frozen ? "policy.frozen" : "policy.unfrozen", { reason: reason ?? null });
    return (await ctx.db.get(policies, id))!;
  },
});
