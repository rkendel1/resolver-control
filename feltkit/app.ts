/**
 * Resolver Control: discover, govern, change and verify the runtime dependencies applications
 * resolve through Resolver (`@appport/resolver`), without redeploying those applications.
 *
 * Who owns what (no second source of truth):
 *
 * | State | Authority | Here |
 * |---|---|---|
 * | What `ref://…` resolves to, its revisions, history, grants, secret material | Resolver | never written here except by the `resolver` component executing an approved change through Resolver's own API |
 * | `observations` | a projection of Resolver, read by the component, stamped with the revision and time it was read | display and impact analysis only; execution never trusts it (every write is conditional on the revision the change was based on, checked by Resolver) |
 * | Ownership, criticality, change class, declared consumers, policies, change records, approvals, evidence, audit | this application (FeltDB) | the collections below |
 *
 * The WebAssembly guest has no network (AppBoundry). The `resolver` component (FeltKit
 * `components`, AppBoundry `components@1`) is the only part that talks to Resolver and the
 * only holder of the Resolver API key. It acts on the application exclusively by calling the
 * functions below as `component:resolver`, with the `executor` role.
 */
import { feltkit, s } from "@feltdb/feltkit";

const READ = ["catalog.read", "changes.read", "policies.read", "activity.read", "insights.read", "settings.read", "discovery.read"];

export const app = feltkit({
  name: "resolver-control",
  version: "0.1.0",
  description: "Runtime dependency and change management on Resolver: inventory, impact, approvals, verified execution and evidence.",
  roles: {
    // Read everything: inventory, changes, evidence, activity.
    viewer: READ,
    // Engineers describe dependencies, declare consumers and propose changes. They cannot approve.
    engineer: [...READ, "catalog.write", "consumers.write", "changes.propose", "changes.cancel", "discovery.write"],
    // Approvers decide changes in unprotected environments.
    approver: [...READ, "changes.approve"],
    // Production approvers also decide changes in protected environments.
    prod_approver: [...READ, "changes.approve", "changes.approve.protected"],
    // Administrators set policies (protection, approvals, freezes) and the Resolver connection.
    admin: [...READ, "catalog.write", "policies.write", "settings.write", "demo.seed"],
    // Agents inspect, declare consumers, submit discovery findings and propose. Never approve or execute;
    // the application also refuses an approval from any non-person principal, whatever its roles.
    agent: [...READ, "consumers.write", "changes.propose", "discovery.write"],
    // A consuming application may declare that it resolves a reference (and nothing else).
    consumer_app: ["catalog.read", "consumers.declare"],
    // The resolver component: records observations, validation and execution evidence; claims approved work.
    executor: ["catalog.read", "changes.read", "settings.read", "observations.write", "changes.execute"],
  },
  dev: {
    users: [
      { id: "ada", name: "Ada Lovelace (Admin, Prod approver)", roles: ["admin", "prod_approver"] },
      { id: "grace", name: "Grace Hopper (Engineer)", roles: ["engineer"] },
      { id: "barbara", name: "Barbara Liskov (Approver)", roles: ["approver"] },
      { id: "linus", name: "Linus Torvalds (Prod approver)", roles: ["prod_approver"] },
      { id: "katherine", name: "Katherine Johnson (Viewer)", roles: ["viewer"] },
      { id: "ops-agent", name: "Ops Agent", roles: ["agent"], type: "agent" },
    ],
  },
  components: {
    resolver: {
      entry: "component/resolver.ts",
      routes: ["/_resolver-control/"],
      required: false,
      principal: { id: "component:resolver", roles: ["executor"], displayName: "Resolver executor" },
      credentials: ["resolver-api-key"],
      network: "egress",
      description: "Observes Resolver, validates proposed changes, executes approved ones with Resolver's conditional writes, and verifies them.",
    },
  },
});


export const CATEGORIES = ["ai", "search", "email", "communications", "payments", "identity", "storage", "analytics", "data", "processing", "integrations", "operations", "credentials", "configuration", "agents", "other"] as const;
export const CRITICALITY = ["low", "medium", "high", "critical"] as const;
/**
 * What it takes to change what a dependency points at.
 * - runtime:   compatible implementations exist behind the same contract; a Resolver change is enough.
 * - adapter:   another implementation needs an adapter in the consuming code before it can be selected.
 * - migration: data or schema migration, or a contract change, is involved; Resolver alone cannot make it.
 * - unknown:   nobody has assessed it.
 */
export const CHANGE_CLASS = ["runtime", "adapter", "migration", "unknown"] as const;
export const KINDS = ["value", "secret", "model", "endpoint", "agent"] as const;

/** Where the Resolver component connects, and which environments (namespaces) this application manages. */
export const settings = app.collection("settings", {
  resolverUrl: s.string({ minLength: 1, maxLength: 2048 }),
  namespaces: s.array(s.string({ minLength: 1, maxLength: 64 })),
  syncIntervalSeconds: s.integer({ minimum: 1, maximum: 3600 }),
  updatedBy: s.string(),
  updatedAt: s.number(),
}, { description: "The Resolver origin and the environments (reference namespaces) under management. The API key is a declared component credential, never stored here." });

/** What the component last saw: written by the component only. */
export const syncStatus = app.collection("syncStatus", {
  state: s.enum(["ok", "error", "unconfigured"]),
  detail: s.optional(s.string({ maxLength: 2000 })),
  at: s.number(),
  references: s.integer({ minimum: 0 }),
  principal: s.optional(s.string()),
}, { description: "The resolver component's last synchronization with Resolver." });

/** Governance metadata Resolver does not hold. One per reference. */
export const dependencies = app.collection("dependencies", {
  ref: s.string({ minLength: 8, maxLength: 256 }),
  environment: s.string(),
  path: s.string(),
  title: s.string({ minLength: 1, maxLength: 120 }),
  description: s.optional(s.string({ maxLength: 2000 })),
  category: s.enum(CATEGORIES),
  owner: s.optional(s.string({ maxLength: 120 })),
  criticality: s.enum(CRITICALITY),
  changeClass: s.enum(CHANGE_CLASS),
  changeClassNote: s.optional(s.string({ maxLength: 1000 })),
  /** The runtime contract consumers rely on, in words (e.g. "OpenAI-compatible chat completions"). */
  contract: s.optional(s.string({ maxLength: 500 })),
  createdBy: s.string(),
  createdAt: s.number(),
  updatedBy: s.string(),
  updatedAt: s.number(),
}, { unique: [["ref"]], indexes: [{ fields: ["environment"] }, { fields: ["path"] }], search: ["title", "ref", "owner"], description: "Ownership, criticality and change class of each runtime dependency." });

const HistoryEntry = s.object({
  revision: s.integer(),
  action: s.string(),
  strategy: s.optional(s.string()),
  targets: s.optional(s.array(s.unknown())),
  actor: s.string(),
  reason: s.optional(s.string()),
  at: s.string(),
  restoredFrom: s.optional(s.integer()),
});

/** A read-only projection of Resolver, stamped with what was read and when. Written by the component only. */
export const observations = app.collection("observations", {
  ref: s.string(),
  environment: s.string(),
  path: s.string(),
  kind: s.enum(KINDS),
  revision: s.integer({ minimum: 0 }),
  state: s.enum(["active", "revoked"]),
  /** Resolver's own updatedAt for the reference. */
  updatedAt: s.string(),
  strategy: s.optional(s.string()),
  /** The binding's targets as Resolver returned them; for secrets, the custody pointer only (Resolver never returns material without reveal). */
  targets: s.array(s.unknown()),
  ttlSeconds: s.optional(s.integer()),
  /** Observed relationship: the secret references a model binding names as credentials. */
  credentialRefs: s.array(s.string()),
  /** The newest history entries Resolver returned (newest first). */
  history: s.array(HistoryEntry),
  /** False when the executor key no longer sees the reference (grant removed). */
  visible: s.boolean(),
  observedAt: s.number(),
}, { unique: [["ref"]], indexes: [{ fields: ["environment"] }, { fields: ["path"] }], description: "What Resolver answered, at which revision, when. Not authoritative." });

/** Who resolves a reference. Resolver does not report consumers, so every entry here is declared, never inferred. */
export const consumers = app.collection("consumers", {
  ref: s.string(),
  application: s.string({ minLength: 1, maxLength: 120 }),
  usage: s.optional(s.string({ maxLength: 500 })),
  source: s.enum(["declared_by_operator", "declared_by_consumer"]),
  declaredBy: s.string(),
  declaredAt: s.number(),
}, { unique: [["ref", "application"]], indexes: [{ fields: ["ref"] }], description: "Applications known to resolve a reference, and who said so." });

/** Per-environment change policy. An environment without a policy is treated as protected (fail safe). */
export const policies = app.collection("policies", {
  environment: s.string({ minLength: 1, maxLength: 64 }),
  protected: s.boolean(),
  approvalsRequired: s.integer({ minimum: 1, maximum: 5 }),
  frozen: s.boolean(),
  freezeReason: s.optional(s.string({ maxLength: 500 })),
  updatedBy: s.string(),
  updatedAt: s.number(),
}, { unique: [["environment"]], description: "Who must approve changes in an environment, and whether it is frozen." });

export const Check = s.object({
  id: s.string(),
  label: s.string(),
  outcome: s.enum(["pass", "fail", "deferred"]),
  detail: s.string(),
});

export const Impact = s.object({
  computedAt: s.number(),
  environment: s.string(),
  protected: s.boolean(),
  frozen: s.boolean(),
  criticality: s.string(),
  changeClass: s.string(),
  requiredApprovals: s.integer(),
  propagation: s.string(),
  declaredConsumers: s.array(s.object({ application: s.string(), usage: s.optional(s.string()), source: s.string() })),
  observedRelationships: s.array(s.object({ ref: s.string(), relation: s.string() })),
  differences: s.array(s.string()),
  fallback: s.string(),
  warnings: s.array(s.string()),
  unknowns: s.array(s.string()),
});

export const STATUSES = ["proposed", "ready", "invalid", "approved", "executing", "verified", "failed", "unknown", "superseded", "rejected", "cancelled"] as const;

/** A proposed, approved, executed and verified change to what a reference resolves to. */
export const changes = app.collection("changes", {
  number: s.integer({ minimum: 1 }),
  ref: s.string(),
  environment: s.string(),
  kind: s.enum(KINDS),
  operation: s.enum(["create", "retarget", "rollback"]),
  /** create/retarget: the binding to write ({ value } or { strategy, targets }). */
  binding: s.optional(s.unknown()),
  /** rollback: the revision whose binding is restored. */
  toRevision: s.optional(s.integer({ minimum: 1 })),
  /** The revision the proposer saw. Resolver refuses the write if the reference has moved since (0 to create). */
  basedOnRevision: s.integer({ minimum: 0 }),
  basedOnTargets: s.array(s.unknown()),
  basedOnStrategy: s.optional(s.string()),
  ttlSeconds: s.optional(s.integer({ minimum: 0, maximum: 86400 })),
  reason: s.string({ minLength: 3, maxLength: 1000 }),
  status: s.enum(STATUSES),
  impact: Impact,
  validation: s.optional(s.object({ at: s.number(), by: s.string(), passed: s.boolean(), checks: s.array(Check) })),
  approvals: s.array(s.object({ by: s.string(), at: s.number(), note: s.optional(s.string()) })),
  decision: s.optional(s.object({ outcome: s.enum(["rejected", "cancelled"]), by: s.string(), at: s.number(), note: s.optional(s.string()) })),
  execution: s.optional(s.object({
    attempt: s.integer({ minimum: 1 }),
    claimedBy: s.string(),
    claimedAt: s.number(),
    finishedAt: s.optional(s.number()),
    resolverRevision: s.optional(s.integer()),
    error: s.optional(s.object({ code: s.string(), reason: s.optional(s.string()), message: s.string() })),
    note: s.optional(s.string()),
  })),
  verification: s.optional(s.object({
    at: s.number(),
    passed: s.boolean(),
    revision: s.integer(),
    currentRevision: s.integer(),
    actor: s.optional(s.string()),
    correlated: s.boolean(),
    bindingMatches: s.boolean(),
    selected: s.optional(s.unknown()),
    checks: s.array(Check),
  })),
  /** The change this one reverts, or the reference this one promotes from. */
  revertOf: s.optional(s.string()),
  promotedFrom: s.optional(s.object({ ref: s.string(), revision: s.integer() })),
  proposedBy: s.string(),
  proposedByType: s.string(),
  proposedAt: s.number(),
  updatedAt: s.number(),
}, { unique: [["number"]], indexes: [{ fields: ["status"] }, { fields: ["ref"] }, { fields: ["environment"] }], description: "Changes to runtime dependencies, from proposal to verified execution." });

/** Hardcoded dependencies that could become references: from the scanner, a person or an agent. */
export const candidates = app.collection("candidates", {
  source: s.enum(["scan", "person", "agent"]),
  repository: s.string({ maxLength: 200 }),
  location: s.string({ maxLength: 400 }),
  category: s.enum(CATEGORIES),
  pattern: s.string({ maxLength: 80 }),
  excerpt: s.string({ maxLength: 300 }),
  suggestedRef: s.optional(s.string({ maxLength: 256 })),
  suggestedKind: s.enum(KINDS),
  rationale: s.string({ maxLength: 1000 }),
  status: s.enum(["open", "adopted", "dismissed"]),
  resolution: s.optional(s.object({ by: s.string(), at: s.number(), note: s.optional(s.string()), ref: s.optional(s.string()) })),
  fingerprint: s.string(),
  submittedBy: s.string(),
  submittedAt: s.number(),
}, { unique: [["fingerprint"]], indexes: [{ fields: ["status"] }], description: "Embedded operational decisions that could be explicit runtime dependencies." });

/** Append-only audit trail; each event names the AppPort request that caused it. */
export const events = app.collection("events", {
  seq: s.integer(),
  subjectType: s.enum(["dependency", "change", "policy", "settings", "consumer", "candidate", "sync"]),
  subjectId: s.string(),
  ref: s.optional(s.string()),
  type: s.string(),
  actor: s.string(),
  actorType: s.string(),
  at: s.number(),
  requestId: s.string(),
  data: s.optional(s.record(s.unknown())),
}, { indexes: [{ fields: ["ref"] }, { fields: ["subjectId"] }], description: "What happened, who did it, from which request." });
