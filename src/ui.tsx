/**
 * The application's UI vocabulary on top of the Stack design system (@stack-ui/react). Stack provides
 * the components; this file keeps only what is Resolver Control's own: the mapping of its states onto
 * Stack's tones, the provenance of a fact (observed, declared, derived), and a few app helpers.
 */
import { createContext, useContext, type ReactNode } from "react";
import {
  Breadcrumbs,
  EmptyState,
  ErrorPanel,
  Loading,
  PageHeader,
  ResourceIdentity,
  StatusIndicator,
  type Tone,
} from "@stack-ui/react";
import type { FeltKitClientError } from "@feltdb/feltkit/react";

export const when = (ms: number | undefined | null) => {
  if (!ms) return "—";
  const diff = Date.now() - ms;
  if (diff < 0) return new Date(ms).toLocaleString();
  if (diff < 45_000) return "just now";
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)} min ago`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)} h ago`;
  return new Date(ms).toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
};
export const exact = (ms: number | undefined | null) => (ms ? new Date(ms).toLocaleString() : "—");

/** Same matching rule as AppPort: exact, "ns.*", or "*". A hint for the UI only; the server decides on every call. */
export function can(granted: readonly string[], permission: string): boolean {
  return granted.some((g) => g === "*" || g === permission || (g.endsWith(".*") && permission.startsWith(g.slice(0, -1))));
}

/**
 * Resolver Control's source states on Stack's state vocabulary: one table per field, never per bare
 * word. An unmapped value renders `unknown` with its own word, never a default of healthy.
 */
type Entry = Tone | [Tone, string];
const P: Tone = "positive", G: Tone = "progress", A: Tone = "attention", C: Tone = "critical", N: Tone = "neutral", U: Tone = "unknown";
export const STATES: Record<string, Record<string, Entry>> = {
  "resolver-control.change.status": {
    proposed: [G, "Awaiting validation"],
    ready: [A, "Awaiting approval"],
    approved: [G, "Approved · queued"],
    executing: [G, "Executing"],
    verified: [P, "Verified"],
    failed: [C, "Failed"],
    unknown: [U, "Outcome unknown"],
    invalid: [C, "Invalid"],
    superseded: [N, "Superseded"],
    rejected: [N, "Rejected"],
    cancelled: [N, "Withdrawn"],
  },
  "resolver-control.dependency.governance": { governed: [P, "Governed"], unregistered: [A, "Unregistered"], not_in_resolver: [N, "Not in Resolver"], not_visible: [C, "Not visible"] },
  "resolver.reference.state": { active: [P, "Active"], revoked: [C, "Revoked"] },
  "resolver-control.sync.state": { ok: [P, "Reachable"], error: [C, "Unreachable"], unconfigured: [A, "Not configured"] },
  "resolver-control.check.outcome": { pass: [P, "Pass"], fail: [C, "Fail"], deferred: [U, "Deferred"] },
  "resolver-control.finding.severity": { action: [C, "Action"], warning: [A, "Warning"], info: [N, "Info"] },
  "resolver-control.dependency.criticality": { critical: [C, "Critical"], high: [A, "High"], medium: [N, "Medium"], low: [N, "Low"] },
  "resolver-control.dependency.change_class": { runtime: [P, "Runtime switch"], adapter: [A, "Needs adapter"], migration: [C, "Needs migration"], unknown: [U, "Not assessed"] },
  "resolver-control.candidate.status": { open: [A, "Open"], adopted: [P, "Adopted"], dismissed: [N, "Dismissed"] },
  "resolver-control.comparison": { same: [P, "Same"], differs: [A, "Differs"] },
};

/** A state, through Stack's StatusIndicator (glyph and words, never colour alone). */
export function State({ field, value, label, detail }: { field: string; value: string; label?: string; detail?: ReactNode }) {
  const entry = STATES[field]?.[value];
  const [tone, word] = entry === undefined ? [U, value.replace(/_/g, " ")] : typeof entry === "string" ? [entry, value.replace(/_/g, " ")] : entry;
  return <StatusIndicator tone={tone} label={label ?? word} detail={detail} attrs={{ "data-field": field, "data-value": value }} />;
}

/** Where a fact came from. Every fact on screen carries one. (Stack has freshness, not provenance: proposed upstream.) */
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

/** A reference name, linked to its page. */
export function Ref({ value, kind, link = true }: { value: string; kind?: string; link?: boolean }) {
  return <ResourceIdentity name={value} {...(kind ? { kind } : {})} {...(link ? { href: `#/dependencies/${encodeURIComponent(value)}` } : {})} />;
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

/** A titled container. Stack has no panel component; this one uses its tokens. */
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

export function Empty({ title, children }: { title: string; children?: ReactNode }) {
  return <EmptyState title={title} body={children} headingLevel={3} />;
}

export function Json({ value, label = "JSON" }: { value: unknown; label?: string }) {
  // Scrollable, so it must be reachable and named for keyboard and screen-reader users.
  return <pre className="json" tabIndex={0} role="region" aria-label={label}>{JSON.stringify(value, null, 2)}</pre>;
}

/** A page's header, with breadcrumbs when it is below a section. */
export function PageHead({ title, crumbs, children, actions, status }: { title: ReactNode; crumbs?: Array<{ label: ReactNode; href?: string }>; children?: ReactNode; actions?: ReactNode; status?: ReactNode }) {
  return (
    <div className="page-head">
      {crumbs && <Breadcrumbs items={[...crumbs, { label: title }]} />}
      <PageHeader title={title} {...(children ? { description: children } : {})} {...(actions ? { actions } : {})} {...(status ? { status } : {})} />
    </div>
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

/** A live query rendered with Stack's loading and error states: never a blank or a guess. */
export function Live<T>({ state, what, children }: { state: { data: T | undefined; error?: unknown }; what?: string; children: (data: T) => ReactNode }) {
  if (state.error) {
    const e = state.error as FeltKitClientError;
    return <ErrorPanel title="Could not load this" message={describe(e)} {...(e?.code ? { code: e.code } : {})} {...(e?.requestId ? { requestId: e.requestId } : {})} />;
  }
  if (state.data === undefined) return <Loading what={what ?? "this page"} />;
  return <>{children(state.data)}</>;
}

/** Asks for a reason in an accessible dialog (Stack's formDialog), instead of window.prompt. */
export async function askReason(title: string, description: string, submitLabel: string, initial = ""): Promise<string | null> {
  const { formDialog } = await import("@stack-ui/react");
  const values = await formDialog({ title, description, submitLabel, cancelLabel: "Cancel", fields: [{ name: "reason", label: "Reason", required: true, multiline: true, rows: 3, value: initial }] });
  const reason = values?.["reason"]?.trim();
  return reason ? reason : null;
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
