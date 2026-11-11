/**
 * The dependency inventory: what Resolver resolves (observed), what people know about it
 * (ownership, criticality, change class: declared), and who consumes it (declared). Every field
 * says where it came from; nothing is inferred into existence.
 */
import { fail, s, type MutationCtx } from "@feltdb/feltkit";
import { app, CATEGORIES, CHANGE_CLASS, changes, consumers, CRITICALITY, dependencies, events, observations, policies, settings } from "./app.js";
import { record } from "./_audit.js";
import { describeBinding, effectivePolicy, environmentNeutral, parseRef, refIn, type WeightedTarget } from "./_rules.js";

const OPEN = new Set(["proposed", "ready", "approved", "executing", "unknown"]);

const Row = s.object({
  ref: s.string(),
  environment: s.string(),
  path: s.string(),
  /** observed: in Resolver and in the catalog; unregistered: in Resolver only; not_in_resolver: catalogued but not observed; not_visible: the executor key lost sight of it. */
  governance: s.enum(["governed", "unregistered", "not_in_resolver", "not_visible"]),
  kind: s.optional(s.string()),
  revision: s.optional(s.integer()),
  state: s.optional(s.string()),
  summary: s.optional(s.string()),
  observedAt: s.optional(s.number()),
  updatedAt: s.optional(s.string()),
  title: s.optional(s.string()),
  category: s.optional(s.string()),
  owner: s.optional(s.string()),
  criticality: s.optional(s.string()),
  changeClass: s.optional(s.string()),
  consumers: s.integer(),
  openChange: s.optional(s.object({ id: s.string(), number: s.integer(), status: s.string() })),
});

export const inventory = app.query({
  access: "catalog.read",
  args: { environment: s.optional(s.string()) },
  returns: s.array(Row),
  capability: { name: "dependencies.list", description: "Every runtime dependency: observed in Resolver, catalogued here, or both, with its current resolution, owner, criticality, change class, declared consumer count and any open change." },
  handler: async (ctx, { environment }) => {
    const filter = environment ? { environment } : {};
    const [observed, catalogued, declared, open] = await Promise.all([
      ctx.db.find(observations, filter),
      ctx.db.find(dependencies, filter),
      ctx.db.find(consumers, {}),
      ctx.db.find(changes, environment ? { environment } : {}),
    ]);
    const meta = new Map(catalogued.map((d) => [d.ref, d]));
    const counts = new Map<string, number>();
    for (const c of declared) counts.set(c.ref, (counts.get(c.ref) ?? 0) + 1);
    const openByRef = new Map(open.filter((c) => OPEN.has(c.status)).map((c) => [c.ref, { id: c.id, number: c.number, status: c.status }]));
    const refs = [...new Set([...observed.map((o) => o.ref), ...catalogued.map((d) => d.ref)])].sort();
    const byRef = new Map(observed.map((o) => [o.ref, o]));
    return refs.map((ref) => {
      const o = byRef.get(ref);
      const d = meta.get(ref);
      const parts = parseRef(ref) as { environment: string; path: string };
      const openChange = openByRef.get(ref);
      return {
        ref,
        environment: parts.environment,
        path: parts.path,
        governance: !o ? ("not_in_resolver" as const) : !o.visible ? ("not_visible" as const) : d ? ("governed" as const) : ("unregistered" as const),
        ...(o ? { kind: o.kind, revision: o.revision, state: o.state, summary: describeBinding(o.kind, o.strategy, o.targets as WeightedTarget[]), observedAt: o.observedAt, updatedAt: o.updatedAt } : {}),
        ...(d ? { title: d.title, category: d.category, criticality: d.criticality, changeClass: d.changeClass, ...(d.owner ? { owner: d.owner } : {}) } : {}),
        consumers: counts.get(ref) ?? 0,
        ...(openChange ? { openChange } : {}),
      };
    });
  },
});

const Observation = s.doc(observations);
const Dependency = s.doc(dependencies);
const Consumer = s.doc(consumers);
const ChangeSummary = s.doc(changes).pick("id", "number", "operation", "status", "reason", "basedOnRevision", "proposedBy", "proposedAt", "updatedAt");
const Event = s.doc(events);

export const detail = app.query({
  access: "catalog.read",
  args: { ref: s.string() },
  returns: s.object({
    ref: s.string(),
    environment: s.string(),
    path: s.string(),
    observation: s.nullable(Observation),
    summary: s.nullable(s.string()),
    dependency: s.nullable(Dependency),
    consumers: s.array(Consumer),
    policy: s.object({ environment: s.string(), protected: s.boolean(), approvalsRequired: s.integer(), frozen: s.boolean(), freezeReason: s.optional(s.string()), explicit: s.boolean() }),
    changes: s.array(ChangeSummary),
    events: s.array(Event),
    counterparts: s.array(s.object({ ref: s.string(), environment: s.string(), revision: s.integer(), kind: s.string(), summary: s.string(), same: s.boolean() })),
    dependents: s.array(s.object({ ref: s.string(), revision: s.integer() })),
    credentials: s.array(s.object({ ref: s.string(), observed: s.boolean(), state: s.optional(s.string()), revision: s.optional(s.integer()) })),
  }),
  capability: { name: "dependencies.inspect", description: "One dependency: its observed resolution and Resolver history, ownership, declared consumers, the environment's policy, its changes and audit events, the same reference in other environments, and observed credential relationships." },
  handler: async (ctx, { ref }) => {
    const parts = parseRef(ref);
    if ("error" in parts) fail("INVALID_ARGUMENT", parts.error);
    const observation = (await ctx.db.find(observations, { ref }, { limit: 1 }))[0] ?? null;
    const dependency = (await ctx.db.find(dependencies, { ref }, { limit: 1 }))[0] ?? null;
    const policyDoc = (await ctx.db.find(policies, { environment: parts.environment }, { limit: 1 }))[0];
    const sameElsewhere = (await ctx.db.find(observations, { path: parts.path })).filter((o) => o.ref !== ref);
    const canon = (o: { strategy?: string; targets: unknown[] }) => JSON.stringify([o.strategy ?? "single", o.targets]);
    const all = observation?.kind === "secret" ? await ctx.db.find(observations, {}) : [];
    const credentialDocs = observation?.credentialRefs.length ? await Promise.all(observation.credentialRefs.map(async (c) => (await ctx.db.find(observations, { ref: c }, { limit: 1 }))[0])) : [];
    const policy = effectivePolicy(parts.environment, policyDoc);
    return {
      ref,
      environment: parts.environment,
      path: parts.path,
      observation,
      summary: observation ? describeBinding(observation.kind, observation.strategy, observation.targets as WeightedTarget[]) : null,
      dependency,
      consumers: await ctx.db.find(consumers, { ref }, { orderBy: [{ field: "application", direction: "asc" }] }),
      policy: { environment: policy.environment, protected: policy.protected, approvalsRequired: policy.approvalsRequired, frozen: policy.frozen, explicit: policy.explicit, ...(policy.freezeReason ? { freezeReason: policy.freezeReason } : {}) },
      changes: (await ctx.db.find(changes, { ref }, { orderBy: [{ field: "number", direction: "desc" }], limit: 25 })).map((c) => ({ id: c.id, number: c.number, operation: c.operation, status: c.status, reason: c.reason, basedOnRevision: c.basedOnRevision, proposedBy: c.proposedBy, proposedAt: c.proposedAt, updatedAt: c.updatedAt })),
      events: await ctx.db.find(events, { ref }, { orderBy: [{ field: "at", direction: "desc" }], limit: 40 }),
      counterparts: sameElsewhere
        .map((o) => ({ ref: o.ref, environment: o.environment, revision: o.revision, kind: o.kind, summary: describeBinding(o.kind, o.strategy, o.targets as WeightedTarget[]), same: observation ? canon(o) === canon(observation) : false }))
        .sort((a, b) => (a.environment < b.environment ? -1 : 1)),
      dependents: all.filter((o) => o.credentialRefs.includes(ref)).map((o) => ({ ref: o.ref, revision: o.revision })),
      credentials: (observation?.credentialRefs ?? []).map((c, i) => {
        const doc = credentialDocs[i];
        return doc ? { ref: c, observed: true, state: doc.visible ? doc.state : "not_visible", revision: doc.revision } : { ref: c, observed: false };
      }),
    };
  },
});

export const register = app.mutation({
  access: "catalog.write",
  args: {
    ref: s.string(),
    title: s.string({ minLength: 1, maxLength: 120 }),
    category: s.enum(CATEGORIES),
    criticality: s.enum(CRITICALITY),
    changeClass: s.enum(CHANGE_CLASS),
    owner: s.optional(s.string({ maxLength: 120 })),
    description: s.optional(s.string({ maxLength: 2000 })),
    contract: s.optional(s.string({ maxLength: 500 })),
    changeClassNote: s.optional(s.string({ maxLength: 1000 })),
  },
  returns: Dependency,
  capability: { name: "dependencies.describe", description: "Record or update what is known about a dependency: title, category, owner, criticality, change class (runtime, adapter, migration, unknown) and the contract consumers rely on. Does not change what it resolves to." },
  handler: async (ctx, args) => {
    const who = ctx.auth.requirePrincipal();
    const parts = parseRef(args.ref);
    if ("error" in parts) fail("INVALID_ARGUMENT", parts.error);
    const existing = (await ctx.db.find(dependencies, { ref: args.ref }, { limit: 1 }))[0];
    const now = Date.now();
    const fields = {
      ...args,
      environment: parts.environment,
      path: parts.path,
      createdBy: existing?.createdBy ?? who.id,
      createdAt: existing?.createdAt ?? now,
      updatedBy: who.id,
      updatedAt: now,
    };
    const id = existing ? (await ctx.db.replace(dependencies, existing.id, fields)).id : await ctx.db.insert(dependencies, fields);
    const changed = existing ? (["title", "category", "criticality", "changeClass", "owner", "contract"] as const).filter((k) => existing[k] !== fields[k]) : [];
    await record(ctx, "dependency", args.ref, existing ? "dependency.described" : "dependency.registered", existing ? Object.fromEntries(changed.map((k) => [k, { from: existing[k] ?? null, to: fields[k] ?? null }])) : { title: args.title, criticality: args.criticality, changeClass: args.changeClass }, args.ref);
    return (await ctx.db.get(dependencies, id))!;
  },
});

async function declare(ctx: MutationCtx, ref: string, application: string, usage: string | undefined, source: "declared_by_operator" | "declared_by_consumer") {
  const who = ctx.auth.requirePrincipal();
  const parts = parseRef(ref);
  if ("error" in parts) fail("INVALID_ARGUMENT", parts.error);
  const existing = (await ctx.db.find(consumers, { ref, application }, { limit: 1 }))[0];
  const fields = { ref, application, ...(usage ? { usage } : {}), source, declaredBy: who.id, declaredAt: Date.now() };
  const id = existing ? (await ctx.db.replace(consumers, existing.id, fields)).id : await ctx.db.insert(consumers, fields);
  await record(ctx, "consumer", id, "consumer.declared", { application, usage: usage ?? null, source }, ref);
  return (await ctx.db.get(consumers, id))!;
}

export const declareConsumer = app.mutation({
  access: "consumers.write",
  args: { ref: s.string(), application: s.string({ minLength: 1, maxLength: 120 }), usage: s.optional(s.string({ maxLength: 500 })) },
  returns: Consumer,
  capability: { name: "consumers.record", description: "Record that an application resolves a reference (declared by an operator or agent; Resolver does not report consumers)." },
  handler: (ctx, { ref, application, usage }) => declare(ctx, ref, application, usage, "declared_by_operator"),
});

/** A consuming application declares itself, under its own principal id. */
export const selfDeclare = app.mutation({
  access: "consumers.declare",
  args: { ref: s.string(), usage: s.optional(s.string({ maxLength: 500 })) },
  returns: Consumer,
  capability: { name: "consumers.declare", description: "A consuming application declares, as itself, that it resolves this reference." },
  handler: (ctx, { ref, usage }) => declare(ctx, ref, ctx.auth.requirePrincipal().id, usage, "declared_by_consumer"),
});

export const removeConsumer = app.mutation({
  access: "consumers.write",
  args: { id: s.string() },
  returns: s.null(),
  capability: { name: "consumers.remove", description: "Remove a consumer declaration." },
  handler: async (ctx, { id }) => {
    const existing = await ctx.db.get(consumers, id);
    if (!existing) fail("NOT_FOUND", `No consumer declaration ${id}.`);
    await ctx.db.delete(consumers, id);
    await record(ctx, "consumer", id, "consumer.removed", { application: existing.application, source: existing.source }, existing.ref);
    return null;
  },
});

/** The environments in view: managed namespaces, observed ones, and those with a policy. */
export const environments = app.query({
  access: "catalog.read",
  returns: s.array(s.object({ environment: s.string(), managed: s.boolean(), references: s.integer(), protected: s.boolean(), approvalsRequired: s.integer(), frozen: s.boolean(), freezeReason: s.optional(s.string()), explicitPolicy: s.boolean() })),
  capability: { name: "environments.list", description: "Environments (reference namespaces): whether managed, how many references are observed, and the change policy that applies." },
  handler: async (ctx) => {
    const config = (await ctx.db.find(settings, {}, { limit: 1 }))[0];
    const observed = await ctx.db.find(observations, {});
    const stored = await ctx.db.find(policies, {});
    const names = [...new Set([...(config?.namespaces ?? []), ...observed.map((o) => o.environment), ...stored.map((p) => p.environment)])].sort();
    return names.map((environment) => {
      const p = effectivePolicy(environment, stored.find((x) => x.environment === environment));
      return {
        environment,
        managed: (config?.namespaces ?? []).includes(environment),
        references: observed.filter((o) => o.environment === environment && o.visible).length,
        protected: p.protected,
        approvalsRequired: p.approvalsRequired,
        frozen: p.frozen,
        ...(p.freezeReason ? { freezeReason: p.freezeReason } : {}),
        explicitPolicy: p.explicit,
      };
    });
  },
});

/** The same reference paths across environments, side by side: what differs, what is missing. */
export const compare = app.query({
  access: "catalog.read",
  args: { environments: s.array(s.string(), { minItems: 2, maxItems: 6 }) },
  returns: s.array(s.object({ path: s.string(), kind: s.optional(s.string()), cells: s.array(s.object({ environment: s.string(), ref: s.string(), present: s.boolean(), revision: s.optional(s.integer()), summary: s.optional(s.string()) })), differs: s.boolean() })),
  capability: { name: "environments.compare", description: "Compare the references with the same path across environments: their resolutions, and where one is missing." },
  handler: async (ctx, { environments: envs }) => {
    const observed = (await ctx.db.find(observations, {})).filter((o) => envs.includes(o.environment) && o.visible);
    const paths = [...new Set(observed.map((o) => o.path))].sort();
    return paths.map((path) => {
      const cells = envs.map((environment) => {
        const o = observed.find((x) => x.path === path && x.environment === environment);
        return o ? { environment, ref: o.ref, present: true, revision: o.revision, summary: describeBinding(o.kind, o.strategy, o.targets as WeightedTarget[]) } : { environment, ref: refIn(environment, path), present: false };
      });
      const kinds = observed.filter((o) => o.path === path).map((o) => o.kind);
      // Each environment naming its own credentials is not a difference.
      const summaries = new Set(cells.map((c) => (c.present ? environmentNeutral(c.summary!) : "<missing>")));
      return { path, ...(kinds[0] ? { kind: kinds[0] } : {}), cells, differs: summaries.size > 1 };
    });
  },
});
