/**
 * The approval signer: the only holder of the change-authorization signing key.
 *
 * It signs one thing: "the change Resolver Control is executing now, exactly as people approved it". The
 * caller names a change and an attempt and nothing else. The signer reads that change from Resolver
 * Control as its own read-only principal, refuses unless the record shows a validated change approved by
 * enough distinct people (none of them the proposer, each approval matched by an audit event a person
 * produced), claimed by the executor at that attempt, inside the signer's scope; then it signs claims
 * derived from the record. Nothing in the request becomes a claim.
 *
 * Runs in its own process (signer/server.ts): never in the application, its component, a browser or an agent.
 */
import type { KeyObject } from "node:crypto";
import { signChangeAuthorization } from "@appport/resolver-client/authorization";
import type { GovernedOperation, GovernedRequest } from "@appport/resolver-core";

/** What the signer reads from Resolver Control (its HTTP API, `changes:get` and `activity:list`). */
export interface ChangeRecord {
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
  status: string;
  validation?: { passed: boolean };
  approvals: Array<{ by: string; at: number }>;
  execution?: { attempt: number; claimedBy: string; claimedAt: number };
  proposedBy: string;
}
export interface ChangeView {
  change: ChangeRecord;
  policy: { frozen: boolean };
  requiredApprovals: number;
}
export interface AuditEvent {
  type: string;
  actor: string;
  actorType: string;
  subjectId: string;
}
export interface Reader {
  change(id: string): Promise<ChangeView | null>;
  events(changeId: string): Promise<AuditEvent[]>;
}

export interface SignerConfig {
  privateKey: KeyObject | string;
  kid: string;
  issuer: string;
  /** The Resolver tenant the executor writes in. */
  tenant: string;
  /** Grant-style patterns (`*`, an exact ref, or a prefix ending in `/*`): the references this signer may authorize. */
  scope: string[];
  /** The principal Resolver Control's component executes as. */
  executor: string;
  /** A floor under Resolver Control's own policy: never fewer approvals than this, whatever its policy says. */
  minApprovals: number;
  validitySeconds: number;
  /** Claims older than this are not signed: the executor signs right after claiming. */
  maxClaimAgeMs: number;
  reader: Reader;
  now?: () => Date;
}

export type SignResult =
  | { ok: true; authorization: string; jti: string; expiresAt: string; ref: string; op: GovernedOperation; expectedRevision: number }
  | { ok: false; reason: string; message: string };

const refuse = (reason: string, message: string): SignResult => ({ ok: false, reason: `signer.${reason}`, message });

export function inScope(scope: string[], ref: string): boolean {
  return scope.some((p) => p === "*" || p === ref || (p.endsWith("/*") && ref.startsWith(p.slice(0, -1))));
}

/** The operation and request Resolver will see for this change: what the engine sends, derived from the record. */
export function governedRequest(change: ChangeRecord): { op: GovernedOperation; request: GovernedRequest } | null {
  if (change.operation === "rollback") return change.toRevision ? { op: "rollback", request: { toRevision: change.toRevision } } : null;
  if (change.kind === "secret") return null; // secret material is never written by Resolver Control
  return { op: "put", request: { kind: change.kind as GovernedRequest["kind"], binding: change.binding, ...(change.ttlSeconds !== undefined ? { ttlSeconds: change.ttlSeconds } : {}) } };
}

export function createSigner(config: SignerConfig) {
  const now = config.now ?? (() => new Date());

  return {
    async sign(input: { changeId: string; attempt: number }): Promise<SignResult> {
      if (typeof input?.changeId !== "string" || !Number.isSafeInteger(input?.attempt) || input.attempt < 1) {
        return refuse("invalid-request", "Name a change id and an attempt number; nothing else is accepted.");
      }
      const view = await config.reader.change(input.changeId);
      if (!view) return refuse("not-found", `Resolver Control has no change ${input.changeId}.`);
      const { change } = view;
      const label = `CHG-${change.number}`;

      if (change.status !== "executing") return refuse("not-executing", `${label} is ${change.status}; only a change being executed is signed.`);
      if (!change.execution || change.execution.attempt !== input.attempt) {
        return refuse("attempt-mismatch", `${label} is at attempt ${change.execution?.attempt ?? 0}, not ${input.attempt}.`);
      }
      if (change.execution.claimedBy !== config.executor) return refuse("not-executor", `${label} is claimed by ${change.execution.claimedBy}, not ${config.executor}.`);
      if (now().getTime() - change.execution.claimedAt > config.maxClaimAgeMs) return refuse("claim-expired", `${label}'s claim is older than ${config.maxClaimAgeMs} ms.`);
      if (change.validation?.passed !== true) return refuse("not-validated", `${label} has not passed validation.`);
      if (view.policy.frozen) return refuse("frozen", `${change.environment} is frozen.`);
      if (!inScope(config.scope, change.ref)) return refuse("out-of-scope", `${change.ref} is outside this signer's scope.`);

      const approvers = change.approvals.map((a) => a.by);
      if (new Set(approvers).size !== approvers.length) return refuse("duplicate-approver", `${label} lists an approver twice.`);
      if (approvers.includes(change.proposedBy)) return refuse("self-approval", `${label} was approved by its proposer.`);
      const required = Math.max(view.requiredApprovals, config.minApprovals);
      if (approvers.length < required) return refuse("insufficient-approvals", `${label} has ${approvers.length} approval(s); ${required} required.`);
      // Each approval must be backed by the audit trail: an approval event whose actor is that approver, a person.
      const events = await config.reader.events(change.id);
      for (const by of approvers) {
        const recorded = events.filter((e) => e.type === "change.approval_recorded" && e.subjectId === change.id && e.actor === by);
        if (!recorded.length) return refuse("approval-unrecorded", `${label}'s approval by ${by} has no audit event.`);
        if (!recorded.some((e) => e.actorType === "user")) return refuse("approval-not-by-person", `${label}'s approval by ${by} was not made by a person.`);
      }

      const governed = governedRequest(change);
      if (!governed) return refuse("unsigned-operation", `${label} is not an operation this signer authorizes.`);
      const jti = `${change.id}.${input.attempt}`;
      const at = now();
      let authorization: string;
      try {
        authorization = signChangeAuthorization({
          privateKey: config.privateKey,
          kid: config.kid,
          issuer: config.issuer,
          tenant: config.tenant,
          ref: change.ref,
          op: governed.op,
          expectedRevision: change.basedOnRevision,
          request: governed.request,
          validitySeconds: config.validitySeconds,
          jti,
          decision: change.id,
          approvers,
          now: at,
        });
      } catch (error) {
        // canonicalChange refuses what Resolver would refuse: nothing unwritable is signed.
        return refuse("invalid-change", `${label} cannot be authorized: ${(error as Error).message}`);
      }
      return { ok: true, authorization, jti, expiresAt: new Date(at.getTime() + config.validitySeconds * 1000).toISOString(), ref: change.ref, op: governed.op, expectedRevision: change.basedOnRevision };
    },
  };
}
