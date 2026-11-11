import { fail, s } from "@feltdb/feltkit";
import { app, settings, syncStatus } from "./app.js";
import { record } from "./_audit.js";

const NAMESPACE = /^[a-z0-9](?:[a-z0-9._-]{0,62}[a-z0-9])?$/;
const Settings = s.doc(settings);
const Sync = s.doc(syncStatus);

export const get = app.query({
  access: "settings.read",
  returns: s.object({ settings: s.nullable(Settings), sync: s.nullable(Sync) }),
  capability: { name: "settings.get", description: "The Resolver origin, the environments under management, and the resolver component's last synchronization." },
  handler: async (ctx) => ({
    settings: (await ctx.db.find(settings, {}, { limit: 1 }))[0] ?? null,
    sync: (await ctx.db.find(syncStatus, {}, { limit: 1 }))[0] ?? null,
  }),
});

export const set = app.mutation({
  access: "settings.write",
  args: {
    resolverUrl: s.string({ minLength: 1, maxLength: 2048 }),
    namespaces: s.array(s.string({ minLength: 1, maxLength: 64 }), { minItems: 1, maxItems: 20 }),
    syncIntervalSeconds: s.optional(s.integer({ minimum: 1, maximum: 3600 })),
  },
  returns: Settings,
  capability: { name: "settings.set", description: "Set the Resolver origin and the environments (reference namespaces) this application manages. The API key is a component credential, set on the host." },
  handler: async (ctx, { resolverUrl, namespaces, syncIntervalSeconds }) => {
    const who = ctx.auth.requirePrincipal();
    if (!/^https?:\/\/[^\s/?#@]+(:\d+)?\/?$/i.test(resolverUrl)) fail("INVALID_ARGUMENT", "resolverUrl must be an origin: http(s)://host[:port], with no path or credentials.");
    const bad = namespaces.find((n) => !NAMESPACE.test(n));
    if (bad !== undefined) fail("INVALID_ARGUMENT", `"${bad}" is not a reference namespace (lowercase letters, digits, ".", "_", "-").`);
    const existing = (await ctx.db.find(settings, {}, { limit: 1 }))[0];
    const fields = { resolverUrl: resolverUrl.replace(/\/$/, ""), namespaces: [...new Set(namespaces)].sort(), syncIntervalSeconds: syncIntervalSeconds ?? existing?.syncIntervalSeconds ?? 5, updatedBy: who.id, updatedAt: Date.now() };
    const id = existing ? (await ctx.db.replace(settings, existing.id, fields)).id : await ctx.db.insert(settings, fields);
    await record(ctx, "settings", id, "settings.changed", { resolverUrl: fields.resolverUrl, namespaces: fields.namespaces, previous: existing ? { resolverUrl: existing.resolverUrl, namespaces: existing.namespaces } : null });
    return (await ctx.db.get(settings, id))!;
  },
});

/** The component's report of its last synchronization. */
export const reportSync = app.mutation({
  access: "observations.write",
  args: { state: s.enum(["ok", "error", "unconfigured"]), detail: s.optional(s.string({ maxLength: 2000 })), references: s.integer({ minimum: 0 }), principal: s.optional(s.string()) },
  handler: async (ctx, args) => {
    const existing = (await ctx.db.find(syncStatus, {}, { limit: 1 }))[0];
    const fields = { ...args, at: Date.now() };
    if (!existing) await ctx.db.insert(syncStatus, fields);
    else {
      await ctx.db.replace(syncStatus, existing.id, fields);
      // Record transitions only, not every heartbeat.
      if (existing.state !== args.state) await record(ctx, "sync", existing.id, `sync.${args.state}`, { detail: args.detail ?? null, previous: existing.state });
    }
    return null;
  },
});
