/**
 * Deterministic rules: reference names, policy, required approvals and impact analysis.
 * Pure functions of the application's state; no model, no I/O, no locale. They run in the
 * WebAssembly guest and in tests alike.
 */

/** Resolver's naming rule (`@appport/resolver-core` names.ts): `ref://<namespace>/<segment>[/…]`. */
const SEGMENT = /^[a-z0-9](?:[a-z0-9._-]{0,62}[a-z0-9])?$/;

export interface RefParts {
  ref: string;
  environment: string;
  path: string;
}

export function parseRef(input: string): RefParts | { error: string } {
  if (typeof input !== "string" || !input.startsWith("ref://")) return { error: "a reference starts with ref://" };
  if (input.length > 256) return { error: "a reference is at most 256 characters" };
  const segments = input.slice("ref://".length).split("/");
  if (segments.length < 2) return { error: "a reference is ref://<environment>/<name>" };
  const bad = segments.find((segment) => !SEGMENT.test(segment));
  if (bad !== undefined) return { error: `"${bad}" is not a valid segment: lowercase letters, digits, ".", "_" and "-"` };
  return { ref: input, environment: segments[0]!, path: segments.slice(1).join("/") };
}

export function refIn(environment: string, path: string): string {
  return `ref://${environment}/${path}`;
}

export interface Policy {
  environment: string;
  protected: boolean;
  approvalsRequired: number;
  frozen: boolean;
  freezeReason?: string | undefined;
  /** False when no policy is recorded and the fail-safe default applies. */
  explicit: boolean;
}

/** An environment without a recorded policy is protected and needs one approval: unknown is never treated as safe. */
export function effectivePolicy(environment: string, stored: { protected: boolean; approvalsRequired: number; frozen: boolean; freezeReason?: string } | null | undefined): Policy {
  if (!stored) return { environment, protected: true, approvalsRequired: 1, frozen: false, explicit: false };
  return { environment, protected: stored.protected, approvalsRequired: stored.approvalsRequired, frozen: stored.frozen, freezeReason: stored.freezeReason, explicit: true };
}

/** A critical dependency always needs at least two distinct approvers. */
export function requiredApprovals(policy: Policy, criticality: string): number {
  return Math.max(policy.approvalsRequired, criticality === "critical" ? 2 : 1);
}

/** Stable JSON: object keys sorted, so two equal bindings compare equal whatever their key order. */
export function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value as Record<string, unknown>)
      .filter((k) => (value as Record<string, unknown>)[k] !== undefined)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canonical((value as Record<string, unknown>)[k])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value ?? null);
}

export interface WeightedTarget {
  value: unknown;
  weight?: number;
  label?: string;
}

/** `{ value }` or `{ strategy, targets }` as targets and strategy, without validating (the component validates with Resolver's own code). */
export function bindingTargets(binding: unknown): { strategy: string; targets: WeightedTarget[] } | null {
  if (!binding || typeof binding !== "object" || Array.isArray(binding)) return null;
  const raw = binding as Record<string, unknown>;
  if ("value" in raw) return { strategy: "single", targets: [{ value: raw["value"] }] };
  if (typeof raw["strategy"] === "string" && Array.isArray(raw["targets"])) return { strategy: raw["strategy"], targets: raw["targets"] as WeightedTarget[] };
  return null;
}

function obj(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function origin(url: unknown): string | null {
  if (typeof url !== "string") return null;
  const match = /^(https?:\/\/[^/?#]+)/i.exec(url);
  return match ? match[1]!.toLowerCase() : null;
}

/** A short, secret-free description of one target, for people. */
export function describeTarget(kind: string, value: unknown): string {
  const v = obj(value);
  switch (kind) {
    case "model":
      return `${String(v["provider"] ?? "?")}/${String(v["model"] ?? "?")}${v["endpoint"] ? ` at ${origin(v["endpoint"]) ?? "?"}` : ""}${v["credential"] ? ` (credential ${String(v["credential"])})` : ""}`;
    case "endpoint":
      return String(v["url"] ?? "?");
    case "agent":
      return `${String(v["origin"] ?? "?")}${v["capabilities"] ? ` pinning ${Object.keys(obj(v["capabilities"])).join(", ")}` : ""}`;
    case "secret":
      return `custody version ${String(v["version"] ?? "?")}`;
    default: {
      const text = canonical(value);
      return text.length > 120 ? `${text.slice(0, 117)}…` : text;
    }
  }
}

export function describeBinding(kind: string, strategy: string | undefined, targets: WeightedTarget[]): string {
  if (!targets.length) return "nothing";
  if (targets.length === 1 && (strategy ?? "single") === "single") return describeTarget(kind, targets[0]!.value);
  return `${strategy}: ${targets.map((t) => `${t.label ? `${t.label} ` : ""}${describeTarget(kind, t.value)}${strategy === "weighted" ? ` (${t.weight ?? 0})` : ""}`).join("; ")}`;
}

/** A binding description with environment namespaces removed: staging and prod naming their own credentials are the same shape. */
export function environmentNeutral(summary: string): string {
  return summary.replace(/ref:\/\/[a-z0-9._-]+\//g, "ref://*/");
}

/** Credential references a model binding names: an observed relationship, read from the binding itself. */
export function credentialRefs(kind: string, targets: WeightedTarget[]): string[] {
  if (kind !== "model") return [];
  return [...new Set(targets.map((t) => obj(t.value)["credential"]).filter((c): c is string => typeof c === "string"))].sort();
}

export interface ObservedConsumer {
  principal: string;
  application?: string | undefined;
  environment?: string | undefined;
  instance?: string | undefined;
  registration?: string | undefined;
  declared: boolean;
  resolvedRevision?: number | undefined;
  resolvedAt?: string | undefined;
  usedRevision?: number | undefined;
  usedOutcome?: string | undefined;
  usedAt?: string | undefined;
}

export interface ImpactInput {
  ref: string;
  kind: string;
  operation: "create" | "retarget" | "rollback";
  policy: Policy;
  dependency: { criticality: string; changeClass: string; contract?: string | undefined } | null;
  current: { revision: number; strategy?: string | undefined; targets: WeightedTarget[]; ttlSeconds?: number | undefined; observedAt: number } | null;
  next: { strategy: string; targets: WeightedTarget[] } | null;
  consumers: Array<{ application: string; usage?: string | undefined; source: string }>;
  /** What Resolver observed resolving (or reported using) this reference; null when it has not been read. */
  observedConsumers?: Array<ObservedConsumer> | null;
  /** Models (in any environment) observed to name this reference as their credential. */
  dependents: string[];
  now: number;
}

/** What is known, and what is not, about the consequences of a change. Everything is labelled by where it came from. */
export function computeImpact(input: ImpactInput) {
  const criticality = input.dependency?.criticality ?? "unassessed";
  const changeClass = input.dependency?.changeClass ?? "unknown";
  const required = requiredApprovals(input.policy, input.dependency?.criticality ?? "medium");
  const differences: string[] = [];
  const warnings: string[] = [];
  const unknowns: string[] = [];
  const observedRelationships: Array<{ ref: string; relation: string }> = [];

  const before = input.current;
  const after = input.next;
  if (input.operation === "create") differences.push(`New reference ${input.ref} (${input.kind}).`);
  if (before && after) {
    const strategyBefore = before.strategy ?? "single";
    if (strategyBefore !== after.strategy) differences.push(`Strategy ${strategyBefore} → ${after.strategy}.`);
    differences.push(`Resolves to ${describeBinding(input.kind, strategyBefore, before.targets)} → ${describeBinding(input.kind, after.strategy, after.targets)}.`);
    if (input.kind === "model") {
      const providers = (ts: WeightedTarget[]) => new Set(ts.map((t) => String(obj(t.value)["provider"] ?? "")));
      const added = [...providers(after.targets)].filter((p) => !providers(before.targets).has(p));
      if (added.length) {
        differences.push(`Introduces provider ${added.join(", ")}.`);
        if (changeClass !== "runtime") warnings.push(`This dependency's change class is "${changeClass}": a new provider may need an adapter or contract work in consumers that Resolver cannot provide.`);
      }
    }
    if (input.kind === "endpoint" || input.kind === "agent") {
      const origins = (ts: WeightedTarget[]) => new Set(ts.map((t) => origin(obj(t.value)[input.kind === "endpoint" ? "url" : "origin"])));
      const fresh = [...origins(after.targets)].filter((o) => o && !origins(before.targets).has(o));
      if (fresh.length) {
        differences.push(`Traffic goes to a system not used before: ${fresh.join(", ")}.`);
        if (changeClass !== "runtime") warnings.push(`This dependency's change class is "${changeClass}": a different system behind the same name needs a compatible contract.`);
      }
    }
    for (const credential of credentialRefs(input.kind, after.targets)) {
      if (!credentialRefs(input.kind, before.targets).includes(credential)) observedRelationships.push({ ref: credential, relation: "credential named by the proposed binding (checked by validation)" });
    }
  }
  if (input.operation === "rollback") differences.push("Restores the binding of an earlier revision exactly as Resolver recorded it.");
  if (!before && input.operation !== "create") unknowns.push("This reference has not been observed in Resolver yet; the current binding is unknown here.");

  for (const dependent of input.dependents) observedRelationships.push({ ref: dependent, relation: "model observed to use this reference as its credential" });
  if (input.kind === "secret") warnings.push("Every model that names this credential resolves the restored material on its next call.");

  const fallback = !after
    ? "not applicable"
    : after.strategy === "failover"
      ? `failover across ${after.targets.length} targets (consumers using withFailover try them in order)`
      : after.strategy === "weighted"
        ? `weighted across ${after.targets.filter((t) => (t.weight ?? 0) > 0).length} active targets (no automatic fallback unless consumers use withFailover)`
        : "single target: no fallback if it is unavailable";

  if (input.policy.frozen) warnings.push(`The ${input.policy.environment} environment is frozen${input.policy.freezeReason ? `: ${input.policy.freezeReason}` : ""}. Nothing executes until it is unfrozen.`);
  if (!input.policy.explicit) warnings.push(`No policy is recorded for ${input.policy.environment}; it is treated as protected.`);
  if (criticality === "unassessed") unknowns.push("Nobody has recorded this dependency's criticality or owner.");
  if (changeClass === "unknown") unknowns.push("Nobody has assessed whether another implementation is a drop-in runtime change.");
  const observed = input.observedConsumers ?? null;
  if (observed === null) {
    if (!input.consumers.length) unknowns.push("No consumer is declared, and Resolver's consumer records have not been read: who is affected is unknown.");
    else unknowns.push("Consumers are declared, not observed: an undeclared application may also resolve this reference.");
  } else {
    const resolving = observed.filter((c) => c.resolvedRevision !== undefined);
    if (resolving.length) warnings.push(`Resolver observed ${resolving.length} consumer(s) resolving this reference: ${resolving.map((c) => c.application ?? c.principal).join(", ")}.`);
    const named = new Set(observed.map((c) => c.application).filter(Boolean));
    const undeclaredHere = [...named].filter((a) => !input.consumers.some((d) => d.application === a));
    if (undeclaredHere.length) warnings.push(`Observed but not declared here: ${undeclaredHere.join(", ")}.`);
    unknowns.push("Observed consumers are those Resolver recorded resolving since it began recording; an application that has not resolved since then is not listed. Usage is reported by consumers, not observed.");
  }
  unknowns.push("Downtime and provider behaviour cannot be observed from Resolver; verification proves what the reference resolves to, not that the new target works.");

  const ttl = before?.ttlSeconds;
  const propagation =
    ttl === undefined
      ? "Running consumers using Resolver's client pick up the change on their next resolution: at once over the live stream, at the latest after the reference's TTL."
      : `Running consumers using Resolver's client pick up the change on their next resolution: at once over the live stream, at the latest after ${ttl} s (the reference's TTL). Calls already in flight finish on the old target.`;

  return {
    computedAt: input.now,
    environment: input.policy.environment,
    protected: input.policy.protected,
    frozen: input.policy.frozen,
    criticality,
    changeClass,
    requiredApprovals: required,
    propagation,
    declaredConsumers: input.consumers.map((c) => ({ application: c.application, ...(c.usage ? { usage: c.usage } : {}), source: c.source })),
    ...(observed ? { observedConsumers: observed } : {}),
    observedRelationships,
    differences,
    fallback,
    warnings,
    unknowns,
  };
}

/** The tag every Resolver write made by this application carries in its reason: the correlation between the change record and Resolver's history. */
export const CORRELATION_PREFIX = "[resolver-control CHG-";
export function correlationTag(number: number, id: string): string {
  return `${CORRELATION_PREFIX}${number} ${id}]`;
}
