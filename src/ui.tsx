/** Shared pieces: formatting, badges, provenance, permissions, routing, queries. */
import { createContext, useContext, type ReactNode } from "react";
import type { FeltKitClientError } from "@feltdb/feltkit/react";

export const when = (ms: number | undefined | null) => {
  if (!ms) return "—";
  const d = new Date(ms);
  const diff = Date.now() - ms;
  if (diff < 0) return d.toLocaleString();
  if (diff < 45_000) return "just now";
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)} min ago`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)} h ago`;
  return d.toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
};
export const exact = (ms: number | undefined | null) => (ms ? new Date(ms).toLocaleString() : "—");

/** Same matching rule as AppPort: exact, "ns.*", or "*". A hint for the UI only; the server decides on every call. */
export function can(granted: readonly string[], permission: string): boolean {
  return granted.some((g) => g === "*" || g === permission || (g.endsWith(".*") && permission.startsWith(g.slice(0, -1))));
}

const TONE: Record<string, string> = {
  verified: "good",
  ready: "info",
  approved: "info",
  executing: "info",
  proposed: "warn",
  unknown: "bad",
  failed: "bad",
  invalid: "bad",
  superseded: "muted",
  rejected: "muted",
  cancelled: "muted",
  governed: "good",
  unregistered: "warn",
  not_in_resolver: "muted",
  not_visible: "bad",
  active: "good",
  revoked: "bad",
  ok: "good",
  error: "bad",
  unconfigured: "warn",
  pass: "good",
  fail: "bad",
  deferred: "muted",
  action: "bad",
  warning: "warn",
  info: "info",
  critical: "bad",
  high: "warn",
  medium: "info",
  low: "muted",
  runtime: "good",
  adapter: "warn",
  migration: "bad",
  open: "warn",
  adopted: "good",
  dismissed: "muted",
};

export const STATUS_LABEL: Record<string, string> = {
  proposed: "awaiting validation",
  ready: "awaiting approval",
  approved: "approved · queued",
  executing: "executing",
  verified: "verified",
  failed: "failed",
  unknown: "outcome unknown",
  invalid: "invalid",
  superseded: "superseded",
  rejected: "rejected",
  cancelled: "withdrawn",
  not_in_resolver: "not in Resolver",
  not_visible: "not visible",
  runtime: "runtime switch",
  adapter: "needs adapter",
  migration: "needs migration",
};

export function Badge({ status, label }: { status: string; label?: string }) {
  return <span className={`badge ${TONE[status] ?? "muted"}`}>{label ?? STATUS_LABEL[status] ?? status.replace(/_/g, " ")}</span>;
}

/** Where a fact came from. Every fact on screen carries one. */
export function Basis({ kind }: { kind: "observed" | "declared" | "derived" | "unknown" }) {
  const title = {
    observed: "Read from Resolver by the resolver component, at the revision and time shown",
    declared: "Recorded by a person, an agent or a consuming application; not verified against running systems",
    derived: "Computed by a deterministic rule from observed and declared facts",
    unknown: "Not known: no source reports it",
  }[kind];
  return (
    <span className={`basis basis-${kind}`} title={title}>
      {kind}
    </span>
  );
}

export function Kind({ kind }: { kind?: string }) {
  return kind ? <span className={`kind kind-${kind}`}>{kind}</span> : <span className="muted">—</span>;
}

export function Ref({ value, link = true }: { value: string; link?: boolean }) {
  return link ? (
    <a className="ref" href={`#/dependencies/${encodeURIComponent(value)}`}>
      {value}
    </a>
  ) : (
    <code className="ref">{value}</code>
  );
}

export function Actor({ id, type }: { id: string; type?: string }) {
  const machine = type === "agent" || type === "service" || id.startsWith("component:");
  return (
    <span className={`actor ${machine ? "machine" : ""}`} title={type ? `${type}: ${id}` : id}>
      {machine ? "◆ " : ""}
      {id}
    </span>
  );
}

export function Card({ title, actions, children, className, subtitle }: { title?: ReactNode; subtitle?: ReactNode; actions?: ReactNode; children: ReactNode; className?: string }) {
  return (
    <section className={`panel ${className ?? ""}`}>
      {(title || actions) && (
        <header className="panel-head">
          <div>
            {title && <h2>{title}</h2>}
            {subtitle && <p className="panel-sub">{subtitle}</p>}
          </div>
          {actions && <div className="panel-actions">{actions}</div>}
        </header>
      )}
      {children}
    </section>
  );
}

export function Empty({ children }: { children: ReactNode }) {
  return <div className="empty-row muted">{children}</div>;
}

export function Json({ value }: { value: unknown }) {
  return <pre className="json">{JSON.stringify(value, null, 2)}</pre>;
}

export function PageHead({ title, children, actions }: { title: ReactNode; children?: ReactNode; actions?: ReactNode }) {
  return (
    <header className="page-head">
      <div>
        <h1>{title}</h1>
        {children && <p className="lede">{children}</p>}
      </div>
      {actions && <div className="page-actions">{actions}</div>}
    </header>
  );
}

/** Hash routes: #/changes/abc → ["changes", "abc"]. */
export const go = (path: string) => {
  window.location.hash = `#/${path}`;
};

export interface AppContext {
  principal: { id: string; type: string; roles: string[] };
  permissions: string[];
  report: (error: unknown) => void;
  info: (text: string) => void;
}
export const Ctx = createContext<AppContext | null>(null);
export const useApp = () => useContext(Ctx)!;

export function describe(error: unknown): string {
  const e = error as FeltKitClientError;
  if (e?.code === "FORBIDDEN") return `Not allowed: ${e.message}`;
  if (e?.code === "UNAUTHORIZED") return "Sign in to continue.";
  return e?.message ?? String(error);
}

/** Run an action, reporting a failure instead of throwing. */
export async function attempt<T>(app: AppContext, fn: () => Promise<T>, done?: string): Promise<T | undefined> {
  try {
    const result = await fn();
    if (done) app.info(done);
    return result;
  } catch (error) {
    app.report(error);
    return undefined;
  }
}

/** A live query rendered with its loading and error states: never a blank or a guess. */
export function Live<T>({ state, children }: { state: { data: T | undefined; error?: unknown }; children: (data: T) => ReactNode }) {
  if (state.error) return <div className="empty-row error-text">{describe(state.error)}</div>;
  if (state.data === undefined) return <div className="empty-row muted">Loading…</div>;
  return <>{children(state.data)}</>;
}

export const EVENT_LABEL: Record<string, string> = {
  "change.proposed": "Change proposed",
  "change.validated": "Validated",
  "change.invalid": "Validation failed",
  "change.superseded": "Superseded: the reference moved",
  "change.approval_recorded": "Approval recorded",
  "change.approved": "Fully approved",
  "change.needs_more_approvals": "Needs more approvals (policy tightened)",
  "change.rejected": "Rejected",
  "change.cancelled": "Withdrawn",
  "change.execution_started": "Execution started",
  "change.reconciliation_started": "Reconciling from Resolver's history",
  "change.verified": "Executed and verified",
  "change.failed": "Resolver refused it",
  "change.unknown": "Outcome unknown",
  "change.requeued": "Not applied; queued again",
  "dependency.registered": "Dependency registered",
  "dependency.described": "Dependency description changed",
  "consumer.declared": "Consumer declared",
  "consumer.removed": "Consumer removed",
  "resolver.change.out_of_band": "Changed directly in Resolver",
  "resolver.reference.not_visible": "No longer visible to the executor",
  "policy.changed": "Policy changed",
  "policy.frozen": "Environment frozen",
  "policy.unfrozen": "Environment unfrozen",
  "settings.changed": "Resolver connection changed",
  "sync.ok": "Resolver reachable",
  "sync.error": "Resolver unreachable",
  "sync.unconfigured": "Resolver connection not configured",
  "candidate.submitted": "Candidate discovered",
  "candidate.adopted": "Candidate adopted",
  "candidate.dismissed": "Candidate dismissed",
  "demo.seeded": "Demo metadata loaded",
};
