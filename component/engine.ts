/**
 * The resolver engine: the only code that talks to Resolver. It reads Resolver into the
 * application's observations, validates proposed changes with Resolver's own binding rules,
 * executes approved changes with Resolver's conditional writes, verifies them against Resolver's
 * history and a fresh resolution, and reconciles any attempt whose outcome was not recorded.
 *
 * It acts on the application only through `call` (the application's functions, as the
 * component's principal) and holds no state of its own beyond a connection: a restart loses
 * nothing, because every step is recorded in the application or in Resolver.
 */
import { ResolverClient, ResolverClientError } from "@appport/resolver-client";
import { checkBinding, isKind, type HistoryEntry, type ReferenceSummary, type ResolveResult } from "@appport/resolver-core";
import { canonical, CORRELATION_PREFIX, correlationTag } from "../feltkit/_rules.js";

export type Call = <T = unknown>(name: string, args?: object) => Promise<T>;
export type Connect = (options: { url: string; apiKey: string; live: boolean; consumer?: { application: string; environment: string } }) => Promise<ResolverClient>;

/** How this component's live connection registers with Resolver (0.4.0): so its own reads are recognisable as its own. */
export const SELF_REGISTRATION = { application: "resolver-control", environment: "control-plane" };

interface Check {
  id: string;
  label: string;
  outcome: "pass" | "fail" | "deferred";
  detail: string;
}

interface Change {
  id: string;
  number: number;
  ref: string;
  environment: string;
  kind: string;
  operation: "create" | "retarget" | "rollback";
  binding?: unknown;
  toRevision?: number;
  basedOnRevision: number;
  ttlSeconds?: number;
  reason: string;
  status: string;
  execution?: { attempt: number; finishedAt?: number; resolverRevision?: number; error?: { code: string } };
}

interface Settings {
  resolverUrl: string;
  namespaces: string[];
  syncIntervalSeconds: number;
  signerUrl?: string;
}

/** Resolver 0.4.0 history: how a revision was authorized. */
interface Governance {
  mode: "authorized" | "break-glass";
  issuer?: string;
  kid?: string;
  jti?: string;
  decision?: string;
  approvers?: string[];
  actor?: string;
  reason?: string;
}
type Entry = HistoryEntry & { governance?: Governance };

/** Resolver's consumer facts for one principal/registration (`resolver.consumers.list`). */
interface ConsumerFacts {
  principal: string;
  registration?: { application: string; environment: string; instance: string; state: string };
  declared: boolean;
  resolved: { latestRevision: number; lastAt: string } | null;
  used: { latestRevision: number; outcome: string; lastAt: string } | null;
}

type SignerAnswer =
  | { ok: true; authorization: string; jti: string; expiresAt: string }
  | { ok: false; refused: boolean; code: string; reason: string; message: string };

export interface EngineOptions {
  call: Call;
  /** The Resolver API key: the component's declared credential. */
  apiKey: () => Promise<string | null>;
  connect?: Connect;
  log?: { info(m: string): void; warn(m: string): void; error(m: string): void };
  /** Called when Resolver reports a change (live stream), so the host can run a tick sooner. */
  onRemoteChange?: () => void;
  /** The token presented to the approval signer: the component's `approval-signer-token` credential. */
  signerToken?: () => Promise<string | null>;
  /** How often consumer facts are read from Resolver for every observed reference (default 30 s). */
  consumersIntervalMs?: number;
  now?: () => number;
}

export interface TickReport {
  state: "ok" | "error" | "unconfigured";
  detail?: string;
  observed: number;
  validated: number;
  executed: number;
  reconciled: number;
  adoption: number;
}

const HISTORY = 20;
/** After the signer could not be reached, an approved change waits this long before it is claimed again. */
export const SIGNER_RETRY_MS = 10_000;
const SEARCH = 100;
const quiet = { info() {}, warn() {}, error() {} };

function asError(error: unknown) {
  if (error instanceof ResolverClientError) return { code: error.code, reason: error.reason, message: error.message, authoritative: error.authoritative };
  const e = error as { code?: string; message?: string; details?: { reason?: string } };
  const code = e?.code ?? "UNAVAILABLE";
  return { code, reason: e?.details?.reason, message: e?.message ?? String(error), authoritative: ["NOT_FOUND", "FORBIDDEN", "UNAUTHORIZED", "INVALID_INPUT", "CONFLICT"].includes(code) };
}

/** Resolver returns history oldest first, and `limit` keeps the newest entries. Everything here reads it newest first. */
async function newestFirst(client: ResolverClient, ref: string, limit: number): Promise<HistoryEntry[]> {
  return [...(await client.history(ref, limit)).entries].reverse();
}

/** Resolver's facts for one consumer, kept apart by basis (declared/used asserted, resolved observed). */
function consumerFact(f: ConsumerFacts) {
  return stripUndefined({
    principal: f.principal,
    application: f.registration?.application,
    environment: f.registration?.environment,
    instance: f.registration?.instance,
    registration: f.registration?.state,
    declared: f.declared,
    resolvedRevision: f.resolved?.latestRevision,
    resolvedAt: f.resolved?.lastAt,
    usedRevision: f.used?.latestRevision,
    usedOutcome: f.used?.outcome,
    usedAt: f.used?.lastAt,
  });
}

const stripUndefined = <T extends Record<string, unknown>>(o: T) => Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as T;

export class ResolverEngine {
  readonly #call: Call;
  readonly #apiKey: EngineOptions["apiKey"];
  readonly #connect: Connect;
  readonly #log: NonNullable<EngineOptions["log"]>;
  readonly #onRemoteChange: EngineOptions["onRemoteChange"];
  #client: ResolverClient | undefined;
  #clientFor: string | undefined;
  #unwatch: (() => void) | undefined;
  readonly #signerToken: NonNullable<EngineOptions["signerToken"]>;
  readonly #consumersIntervalMs: number;
  readonly #now: () => number;
  #consumersReadAt = 0;
  /**
   * The executor key's own Resolver principal. Resolver records this component's reads (synchronization,
   * verification) as resolutions like any consumer's, and has no "who am I": it is learned from this
   * component's own consumer registration (SELF_REGISTRATION) or from the actor Resolver recorded on this
   * application's own writes, kept in syncStatus, and excluded from consumers.
   */
  #self: string | undefined;

  constructor(options: EngineOptions) {
    this.#call = options.call;
    this.#apiKey = options.apiKey;
    this.#connect = options.connect ?? ((o) => ResolverClient.connect({ ...o, timeoutMs: 5000, maxStaleSeconds: 0 }));
    this.#log = options.log ?? quiet;
    this.#onRemoteChange = options.onRemoteChange;
    this.#signerToken = options.signerToken ?? (async () => null);
    this.#consumersIntervalMs = options.consumersIntervalMs ?? 30_000;
    this.#now = options.now ?? Date.now;
  }

  /** One pass: observe, supersede stale proposals, validate, reconcile, execute. Each step records its own evidence. */
  async tick(): Promise<TickReport> {
    const report: TickReport = { state: "ok", observed: 0, validated: 0, executed: 0, reconciled: 0, adoption: 0 };
    const { settings, sync } = await this.#call<{ settings: Settings | null; sync: { principal?: string } | null }>("settings:get");
    this.#self ??= sync?.principal;
    const apiKey = await this.#apiKey();
    if (!settings || !apiKey) {
      const detail = !settings ? "No Resolver origin is set (Settings)." : "The resolver-api-key credential is not set on this host.";
      await this.#call("settings:reportSync", { state: "unconfigured", detail, references: 0 });
      return { ...report, state: "unconfigured", detail };
    }
    let client: ResolverClient;
    try {
      client = await this.#clientFor_(settings.resolverUrl, apiKey);
      report.observed = await this.#sync(client, settings);
      await this.#call("settings:reportSync", { state: "ok", references: report.observed, ...(this.#self ? { principal: this.#self } : {}) });
    } catch (error) {
      const e = asError(error);
      this.#dropClient();
      await this.#call("settings:reportSync", { state: "error", detail: `${e.code}: ${e.message}`, references: 0 });
      return { ...report, state: "error", detail: e.message };
    }
    const learned = this.#self;
    const work = await this.#call<{ validate: Change[]; execute: Change[]; reconcile: Change[]; adopt: Change[]; stale: Array<{ id: string; currentRevision: number }> }>("changes:work");
    for (const s of work.stale) await this.#call("changes:supersede", s).catch((e) => this.#log.warn(`supersede ${s.id}: ${asError(e).message}`));
    for (const change of work.validate) {
      await this.#validate(client, change).catch((e) => this.#log.warn(`validate CHG-${change.number}: ${asError(e).message}`));
      report.validated += 1;
    }
    for (const change of work.reconcile) {
      await this.#reconcile(settings, apiKey, client, change).catch((e) => this.#log.warn(`reconcile CHG-${change.number}: ${asError(e).message}`));
      report.reconciled += 1;
    }
    const signerToken = settings.signerUrl ? await this.#signerToken() : null;
    for (const change of work.execute) {
      if (settings.signerUrl && !signerToken) {
        report.detail = "An approval signer is set, but the approval-signer-token credential is not: approved changes wait.";
        this.#log.warn(report.detail);
        break;
      }
      // The signer was unreachable for this change a moment ago: give it time before claiming again.
      if (change.execution?.error?.code === "SIGNER_UNAVAILABLE" && this.#now() - (change.execution.finishedAt ?? 0) < SIGNER_RETRY_MS) continue;
      await this.#execute(settings, apiKey, client, change, signerToken).catch((e) => this.#log.warn(`execute CHG-${change.number}: ${asError(e).message}`));
      report.executed += 1;
    }
    // Writes were made: observe again now, so the projection does not lag behind verified changes.
    if (report.executed || report.reconciled) {
      report.observed = await this.#sync(client, settings).catch((e) => (this.#log.warn(`sync after execution: ${asError(e).message}`), report.observed));
    }
    if (this.#self && this.#self !== learned) await this.#call("settings:reportSync", { state: "ok", references: report.observed, principal: this.#self });
    // Adoption and consumers: Resolver's runtime evidence, read; never inferred here.
    for (const change of work.adopt) {
      if (await this.#adoption(client, change).catch((e) => (this.#log.warn(`adoption CHG-${change.number}: ${asError(e).message}`), false))) report.adoption += 1;
    }
    if (this.#now() - this.#consumersReadAt >= this.#consumersIntervalMs) {
      await this.#consumers(client).catch((e) => this.#log.warn(`consumers: ${asError(e).message}`));
      this.#consumersReadAt = this.#now();
    }
    return report;
  }

  async close(): Promise<void> {
    this.#dropClient();
  }

  // ---- connection ---------------------------------------------------------------------------

  async #clientFor_(url: string, apiKey: string): Promise<ResolverClient> {
    const identity = `${url}\u0000${apiKey}`;
    if (this.#client && this.#clientFor === identity) return this.#client;
    this.#dropClient();
    // Registered as a consumer, so Resolver's consumer records name this component's principal (it has no "who am I").
    // A Resolver without registration (before 0.4.0) refuses it: connect unregistered.
    this.#client = await this.#connect({ url, apiKey, live: true, consumer: SELF_REGISTRATION }).catch(() => this.#connect({ url, apiKey, live: true }));
    this.#clientFor = identity;
    // Resolver streams change notifications; a remote change makes the host tick sooner (the interval still bounds it).
    this.#unwatch = this.#client.watch("ref://", () => this.#onRemoteChange?.());
    return this.#client;
  }

  #dropClient() {
    this.#unwatch?.();
    void this.#client?.close().catch(() => undefined);
    this.#client = undefined;
    this.#clientFor = undefined;
    this.#unwatch = undefined;
  }

  // ---- observation --------------------------------------------------------------------------

  async #sync(client: ResolverClient, settings: Settings): Promise<number> {
    const known = new Map((await this.#call<Array<{ ref: string; revision: number; state: string; visible: boolean }>>("observations:index")).map((o) => [o.ref, o]));
    const seen: ReferenceSummary[] = [];
    for (const namespace of settings.namespaces) seen.push(...(await client.list(`ref://${namespace}/`)).refs);
    const moved = seen.filter((r) => {
      const k = known.get(r.ref);
      return !k || k.revision !== r.revision || k.state !== r.state || !k.visible;
    });
    const items = [];
    for (const summary of moved) {
      const history = await newestFirst(client, summary.ref, HISTORY);
      for (const h of history) if ((h.reason ?? "").includes(CORRELATION_PREFIX)) this.#learnSelf(h.actor);
      let binding: Pick<ResolveResult, "strategy" | "targets"> & { ttlSeconds?: number };
      if (summary.state === "active") {
        // Pinned to the listed revision: exactly that binding, whatever any cache holds.
        const pinned = await client.resolve(summary.ref, { revision: summary.revision });
        binding = { strategy: pinned.strategy, targets: pinned.targets, ttlSeconds: pinned.ttlSeconds };
      } else {
        const last = history.find((h) => h.action !== "revoke" && h.targets);
        binding = { strategy: last?.strategy ?? "single", targets: last?.targets ?? [] };
      }
      items.push(stripUndefined({
        ref: summary.ref,
        kind: summary.kind,
        revision: summary.revision,
        state: summary.state,
        updatedAt: summary.updatedAt,
        strategy: binding.strategy,
        targets: binding.targets,
        ttlSeconds: binding.ttlSeconds,
        history: history.map((h) => stripUndefined({ ...h })),
      }));
    }
    for (let i = 0; i < items.length; i += 25) await this.#call("observations:upsert", { items: items.slice(i, i + 25) });
    const listed = new Set<string>(seen.map((r) => r.ref));
    const inScope = (ref: string) => settings.namespaces.some((n) => ref.startsWith(`ref://${n}/`));
    const gone = [...known.values()].filter((k) => k.visible && inScope(k.ref) && !listed.has(k.ref)).map((k) => k.ref);
    if (gone.length) await this.#call("observations:hide", { refs: gone });
    return seen.length;
  }

  /** The newest revision Resolver records for a reference (0 if it does not exist), read uncached from its history. */
  async #currentRevision(client: ResolverClient, ref: string): Promise<{ revision: number; entries: HistoryEntry[] } | { error: ReturnType<typeof asError> }> {
    try {
      const entries = await newestFirst(client, ref, SEARCH);
      return { revision: entries[0]?.revision ?? 0, entries };
    } catch (error) {
      const e = asError(error);
      if (e.reason === "resolver.not-found" || e.code === "NOT_FOUND") return { revision: 0, entries: [] };
      return { error: e };
    }
  }

  // ---- validation ---------------------------------------------------------------------------

  async #validate(client: ResolverClient, change: Change) {
    const checks: Check[] = [];
    const current = await this.#currentRevision(client, change.ref);
    if ("error" in current) {
      checks.push({ id: "revision", label: "Reference unchanged since the proposal", outcome: current.error.code === "FORBIDDEN" ? "fail" : "deferred", detail: `Resolver answered ${current.error.code}: ${current.error.message}` });
    } else if (current.revision !== change.basedOnRevision) {
      await this.#call("changes:recordValidation", {
        id: change.id,
        checks: [{ id: "revision", label: "Reference unchanged since the proposal", outcome: "fail", detail: `Proposed against revision ${change.basedOnRevision}; Resolver is at ${current.revision}.` }],
        superseded: { currentRevision: current.revision },
      });
      return;
    } else {
      checks.push({ id: "revision", label: "Reference unchanged since the proposal", outcome: "pass", detail: change.operation === "create" ? "The reference does not exist yet." : `Resolver is at revision ${current.revision}, as proposed.` });
    }

    let targets: Array<{ value: unknown }> = [];
    if (change.operation === "rollback") {
      const entries = "entries" in current ? current.entries : [];
      const restored = entries.find((h) => h.revision === change.toRevision);
      if (!restored) checks.push({ id: "target-revision", label: "Revision to restore", outcome: entries.length >= SEARCH ? "deferred" : "fail", detail: entries.length >= SEARCH ? `Revision ${change.toRevision} is older than the ${SEARCH} newest; Resolver checks it at execution.` : `Revision ${change.toRevision} is not in ${change.ref}'s history.` });
      else if (restored.action === "revoke" || !restored.targets) checks.push({ id: "target-revision", label: "Revision to restore", outcome: "fail", detail: `Revision ${change.toRevision} is a ${restored.action} with no binding to restore.` });
      else {
        checks.push({ id: "target-revision", label: "Revision to restore", outcome: "pass", detail: `Revision ${change.toRevision} (${restored.action} by ${restored.actor}, ${restored.at}).` });
        targets = restored.targets as Array<{ value: unknown }>;
      }
    } else {
      // Resolver's own structural rules (@appport/resolver-core), the code Resolver runs on every write.
      const kind = change.kind;
      const checked = isKind(kind) ? checkBinding(kind, change.binding) : { ok: false as const, error: `unknown kind ${kind}` };
      if (checked.ok) {
        checks.push({ id: "binding", label: "Binding is valid for the kind", outcome: "pass", detail: `A ${checked.value.strategy} binding with ${checked.value.targets.length} target(s), valid for ${kind} by Resolver's rules.` });
        targets = checked.value.targets;
      } else checks.push({ id: "binding", label: "Binding is valid for the kind", outcome: "fail", detail: checked.error });
    }

    const crossing = [...new Set(JSON.stringify(targets).match(/ref:\/\/[a-z0-9._-]+\//g) ?? [])].filter((r) => r !== `ref://${change.environment}/`);
    checks.push(crossing.length
      ? { id: "environment", label: "Stays inside its environment", outcome: "fail", detail: `Names references in another environment: ${crossing.join(", ")}.` }
      : { id: "environment", label: "Stays inside its environment", outcome: "pass", detail: `Every reference it names is under ref://${change.environment}/.` });

    if (change.kind === "model") {
      const credentials = [...new Set(targets.map((t) => (t.value as { credential?: string })?.credential).filter((c): c is string => typeof c === "string"))];
      for (const credential of credentials) {
        try {
          const resolved = await client.resolve(credential);
          checks.push(resolved.kind === "secret"
            ? { id: `credential:${credential}`, label: `Credential ${credential}`, outcome: "pass", detail: `An active secret at revision ${resolved.revision}.` }
            : { id: `credential:${credential}`, label: `Credential ${credential}`, outcome: "fail", detail: `${credential} is a ${resolved.kind}, not a secret.` });
        } catch (error) {
          const e = asError(error);
          checks.push({ id: `credential:${credential}`, label: `Credential ${credential}`, outcome: e.code === "FORBIDDEN" || !e.authoritative ? "deferred" : "fail", detail: e.code === "FORBIDDEN" ? "The executor key may not read it; Resolver checks it at execution." : `${e.code}: ${e.message}` });
        }
      }
      if (change.operation !== "rollback") checks.push({ id: "catalog", label: "Provider and model in the Intelligence catalog", outcome: "deferred", detail: "Resolver checks provider and model against the AppPort Services Intelligence catalog when it writes; it has no dry run." });
    }
    if (change.kind === "value" && change.operation !== "rollback") checks.push({ id: "schema", label: "Matches the reference's JSON Schema", outcome: "deferred", detail: "Resolver checks the schema fixed at creation when it writes; the schema is not readable through its API." });
    if (change.kind === "agent" && change.operation !== "rollback") checks.push({ id: "agent-contract", label: "Pinned capability digests", outcome: "deferred", detail: "Resolver discovers the agent and recomputes every pinned digest when it writes." });
    if (change.kind === "endpoint") checks.push({ id: "reachability", label: "Target reachable", outcome: "deferred", detail: "Not probed: this application does not send requests to arbitrary targets. Resolution is verified after execution; behaviour is the consumer's to observe." });
    checks.push({ id: "write-grant", label: "Executor key may write here", outcome: "deferred", detail: "Resolver's grants decide at execution; a refusal leaves the reference unchanged." });

    await this.#call("changes:recordValidation", { id: change.id, checks });
  }

  // ---- execution ----------------------------------------------------------------------------

  async #execute(settings: Settings, apiKey: string, client: ResolverClient, change: Change, signerToken: string | null) {
    const claimed = await this.#call<Change>("changes:claim", { id: change.id });
    if (claimed.status !== "executing") return; // e.g. policy tightened: back to awaiting approval
    const attempt = claimed.execution!.attempt;
    const tag = correlationTag(change.number, change.id);
    const reason = `${tag} ${change.reason}`.slice(0, 1000);

    // With an approval signer: ask it for this attempt's authorization. It reads the change itself and signs
    // only what people approved; this component never holds the key and sends nothing but the change id.
    let authorization: string | undefined;
    if (settings.signerUrl && signerToken) {
      const answer = await this.#requestAuthorization(settings.signerUrl, signerToken, change.id, attempt);
      if (!answer.ok) {
        const error = { code: answer.code, reason: answer.reason, message: answer.message };
        return answer.refused
          ? this.#call("changes:settle", { id: change.id, attempt, outcome: "failed", error, note: "The approval signer refused to authorize this change; nothing was sent to Resolver." })
          : this.#call("changes:settle", { id: change.id, attempt, outcome: "requeue", error, note: "The approval signer could not be reached; nothing was sent to Resolver. The change waits under the same approval." });
      }
      await this.#call("changes:recordAuthorization", { id: change.id, attempt, jti: answer.jti, expiresAt: answer.expiresAt });
      authorization = answer.authorization;
    }

    let revision: number;
    try {
      const result =
        change.operation === "rollback"
          ? await client.rollback(change.ref, change.toRevision!, change.basedOnRevision, reason, authorization ? { authorization } : {})
          : await client.put({ ref: change.ref, ...(change.operation === "create" ? { kind: change.kind as never } : {}), binding: change.binding, expectedRevision: change.basedOnRevision, reason, ...(change.ttlSeconds !== undefined ? { ttlSeconds: change.ttlSeconds } : {}), ...(authorization ? { authorization } : {}) });
      revision = result.revision;
    } catch (error) {
      const e = asError(error);
      // Stale, or the authorization was already consumed: something committed. Resolver's history says whether it was this change.
      if (e.reason === "resolver.stale-revision" || e.reason === "resolver.authorization-consumed" || e.code === "CONFLICT") {
        // Someone else moved the reference, or an earlier attempt of ours already applied it: Resolver's history says which.
        return this.#settleFromHistory(settings, apiKey, client, change, attempt, `Resolver refused the write as stale (${e.message}).`);
      }
      if (e.authoritative) {
        return this.#call("changes:settle", { id: change.id, attempt, outcome: "failed", error: stripUndefined({ code: e.code, reason: e.reason, message: e.message }), note: "Resolver refused the write; the reference is unchanged." });
      }
      // Transport failure: the write may or may not have happened. Never guessed: reconciled from history.
      return this.#call("changes:settle", { id: change.id, attempt, outcome: "unknown", error: stripUndefined({ code: e.code, reason: e.reason, message: e.message }), note: "No answer from Resolver; the outcome is determined from its history on the next pass." });
    }
    const verification = await this.#verify(settings, apiKey, change, revision);
    await this.#call("changes:settle", { id: change.id, attempt, outcome: verification.passed ? "verified" : "unknown", resolverRevision: revision, verification, ...(verification.passed ? {} : { note: "Resolver accepted the write, but verification did not confirm it; a person must look." }) });
  }

  async #requestAuthorization(signerUrl: string, token: string, changeId: string, attempt: number): Promise<SignerAnswer> {
    let response: Response;
    try {
      response = await fetch(`${signerUrl}/sign`, { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: JSON.stringify({ changeId, attempt }), signal: AbortSignal.timeout(5000) });
    } catch (error) {
      return { ok: false, refused: false, code: "SIGNER_UNAVAILABLE", reason: "signer.unreachable", message: `The approval signer did not answer: ${(error as Error).message}` };
    }
    const body = (await response.json().catch(() => null)) as { authorization?: string; jti?: string; expiresAt?: string; reason?: string; message?: string } | null;
    if (response.ok && body?.authorization && body.jti && body.expiresAt) return { ok: true, authorization: body.authorization, jti: body.jti, expiresAt: body.expiresAt };
    // 401/403/400: a decision (or a misconfigured token). 5xx: the signer, or its read of this application, failed: retry.
    const refused = response.status >= 400 && response.status < 500;
    return { ok: false, refused, code: refused ? "SIGNER_REFUSED" : "SIGNER_UNAVAILABLE", reason: body?.reason ?? `signer.http-${response.status}`, message: body?.message ?? `The approval signer answered ${response.status}.` };
  }

  async #reconcile(settings: Settings, apiKey: string, client: ResolverClient, change: Change) {
    const claimed = await this.#call<Change>("changes:claim", { id: change.id });
    await this.#settleFromHistory(settings, apiKey, client, change, claimed.execution!.attempt, "Reconciled from Resolver's history after an unrecorded outcome.");
  }

  /** Find this change in Resolver's history by its correlation tag: applied (verify it), not applied and safe to retry, or superseded. */
  async #settleFromHistory(settings: Settings, apiKey: string, client: ResolverClient, change: Change, attempt: number, why: string) {
    const tag = correlationTag(change.number, change.id);
    const current = await this.#currentRevision(client, change.ref);
    if ("error" in current) {
      return this.#call("changes:settle", { id: change.id, attempt, outcome: "unknown", error: stripUndefined({ code: current.error.code, reason: current.error.reason, message: current.error.message }), note: `${why} Resolver's history could not be read.` });
    }
    const ours = (current.entries as Entry[]).find((h) => (h.reason ?? "").includes(tag) || h.governance?.decision === change.id);
    if (ours) {
      const verification = await this.#verify(settings, apiKey, change, ours.revision);
      return this.#call("changes:settle", { id: change.id, attempt, outcome: verification.passed ? "verified" : "unknown", resolverRevision: ours.revision, verification, note: `${why} Resolver's history shows this change applied as revision ${ours.revision}.` });
    }
    if (current.revision === change.basedOnRevision) {
      // Nothing applied and nothing else changed: executing again is exactly what was approved (the write is conditional).
      return this.#call("changes:settle", { id: change.id, attempt, outcome: "requeue", note: `${why} Not applied; ${change.ref} is still at revision ${current.revision}. Queued to execute again.` });
    }
    return this.#call("changes:settle", { id: change.id, attempt, outcome: "superseded", note: `${why} Not applied; ${change.ref} moved from revision ${change.basedOnRevision} to ${current.revision} by ${current.entries[0]?.actor ?? "someone"}.` });
  }

  // ---- adoption and consumers (Resolver 0.4.0) -------------------------------------------------

  /** Resolver's actor is `<type>:<principal id>`; consumer facts carry the principal id. */
  #learnSelf(actor: string) {
    const id = actor.slice(actor.indexOf(":") + 1);
    if (id) this.#self = id;
  }

  /** Consumers other than this component: its own reads are not consumption. */
  #others(facts: ConsumerFacts[]): ConsumerFacts[] {
    const own = facts.find((f) => f.registration?.application === SELF_REGISTRATION.application && f.registration.environment === SELF_REGISTRATION.environment);
    if (own) this.#self = own.principal;
    return facts.filter((f) => f.principal !== this.#self);
  }

  async #adoption(client: ResolverClient, change: Change): Promise<boolean> {
    const revision = change.execution!.resolverRevision!;
    const a = (await client.adoption(change.ref, revision)) as {
      revision: number;
      currentRevision: number;
      authorized: { mode: string; jti?: string; issuer?: string; consumedAt?: string };
      committed: { at: string };
      available: { current: boolean; until: string | null };
      fetched: { consumers: ConsumerFacts[] };
      notYetFetched: { consumers: ConsumerFacts[] };
      adopted: { consumers: ConsumerFacts[] };
    };
    await this.#call("changes:recordAdoption", {
      id: change.id,
      adoption: {
        at: this.#now(),
        revision: a.revision,
        currentRevision: a.currentRevision,
        authorized: stripUndefined({ mode: a.authorized.mode, jti: a.authorized.jti, issuer: a.authorized.issuer, consumedAt: a.authorized.consumedAt }),
        committedAt: a.committed.at,
        available: { current: a.available.current, until: a.available.until },
        fetched: this.#others(a.fetched.consumers).map(consumerFact),
        notYetFetched: this.#others(a.notYetFetched.consumers).map(consumerFact),
        adopted: this.#others(a.adopted.consumers).map(consumerFact),
        functionallyVerified: null,
      },
    });
    return true;
  }

  async #consumers(client: ResolverClient) {
    const refs = (await this.#call<Array<{ ref: string; visible: boolean }>>("observations:index")).filter((o) => o.visible).map((o) => o.ref);
    const items = [];
    for (const ref of refs) {
      const facts = (await client.consumers(ref)) as { consumers: ConsumerFacts[] };
      items.push({ ref, consumers: this.#others(facts.consumers).slice(0, 200).map(consumerFact) });
    }
    for (let i = 0; i < items.length; i += 25) await this.#call("observations:recordConsumers", { items: items.slice(i, i + 25) });
  }

  // ---- verification -------------------------------------------------------------------------

  /** Proves what Resolver now records and resolves, with a fresh client (no cache), against what was approved. */
  async #verify(settings: Settings, apiKey: string, change: Change, revision: number) {
    const tag = correlationTag(change.number, change.id);
    const checks: Check[] = [];
    const fresh = await this.#connect({ url: settings.resolverUrl, apiKey, live: false });
    try {
      const entries = await newestFirst(fresh, change.ref, SEARCH);
      const entry = entries.find((h) => h.revision === revision);
      const correlated = Boolean(entry && (entry.reason ?? "").includes(tag));
      const governance = (entry as Entry | undefined)?.governance;
      // With a signer, the revision must carry an authorization for this change: Resolver verified and consumed it.
      const authorized = governance?.mode === "authorized" && governance.decision === change.id && (governance.jti ?? "").startsWith(`${change.id}.`);
      if (settings.signerUrl || governance) {
        checks.push(authorized
          ? { id: "authorization", label: "Authorized for this change", outcome: "pass", detail: `Resolver verified and consumed authorization ${governance!.jti} (issuer ${governance!.issuer}, key ${governance!.kid}).` }
          : { id: "authorization", label: "Authorized for this change", outcome: "fail", detail: governance ? `Resolver recorded ${governance.mode}${governance.decision ? ` for ${governance.decision}` : ""}, not an authorization for this change.` : "Resolver recorded no authorization for this revision." });
      }
      const authorizationOk = !(settings.signerUrl || governance) || authorized;
      if (entry && (correlated || authorized)) this.#learnSelf(entry.actor);
      checks.push(entry
        ? { id: "history", label: "Recorded in Resolver's history", outcome: "pass", detail: `Revision ${revision}: ${entry.action} by ${entry.actor} at ${entry.at}.` }
        : { id: "history", label: "Recorded in Resolver's history", outcome: "fail", detail: `Revision ${revision} is not in ${change.ref}'s history.` });
      checks.push({ id: "correlation", label: "Resolver's record names this change", outcome: correlated ? "pass" : "fail", detail: correlated ? `The revision's reason carries ${tag}.` : `The revision's reason does not carry ${tag}.` });

      let expected: { strategy: string; targets: unknown[] } | null = null;
      if (change.operation === "rollback") {
        const restored = entries.find((h) => h.revision === change.toRevision);
        if (restored?.targets) expected = { strategy: restored.strategy ?? "single", targets: restored.targets };
      } else if (isKind(change.kind)) {
        const checked = checkBinding(change.kind, change.binding);
        if (checked.ok) expected = { strategy: checked.value.strategy, targets: checked.value.targets };
      }
      const recorded = entry?.targets ? { strategy: entry.strategy ?? "single", targets: entry.targets } : null;
      const bindingMatches = Boolean(expected && recorded && canonical(expected) === canonical(recorded));
      checks.push({ id: "binding", label: "Recorded binding is the approved one", outcome: bindingMatches ? "pass" : "fail", detail: bindingMatches ? "Identical, target for target." : expected ? "The recorded binding differs from the approved one." : "The approved binding could not be reconstructed." });

      // What a consumer resolving the reference gets now (a first resolution: nothing cached).
      const resolved = await fresh.resolve(change.ref);
      const current = resolved.revision;
      checks.push(current === revision
        ? { id: "resolves", label: "Consumers resolve the new binding", outcome: "pass", detail: `${change.ref} resolves at revision ${current}${resolved.selected.label ? ` (selected: ${resolved.selected.label})` : ""}.` }
        : { id: "resolves", label: "Consumers resolve the new binding", outcome: current > revision ? "deferred" : "fail", detail: current > revision ? `Already superseded by revision ${current} (written after this change).` : `Resolves at revision ${current}, before this change.` });
      return stripUndefined({
        at: Date.now(),
        passed: Boolean(entry) && correlated && bindingMatches && authorizationOk && current >= revision,
        revision,
        currentRevision: current,
        actor: entry?.actor,
        correlated,
        bindingMatches,
        selected: change.kind === "secret" ? undefined : resolved.selected.value,
        checks,
        governance,
      });
    } finally {
      await fresh.close().catch(() => undefined);
    }
  }
}
