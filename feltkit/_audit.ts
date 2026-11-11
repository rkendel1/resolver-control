/**
 * Records an audit event through FeltKit's app.auditTrail: in the mutation's transaction, with the actor,
 * the request id and a per-subject sequence. Reads that span a reference (its own events and its changes')
 * go through referenceHistory.
 */
import { s, type MutationCtx, type QueryCtx } from "@feltdb/feltkit";
import { changes, events } from "./app.js";

/**
 * The stored event, typed. app.auditTrail (FeltKit 0.3.25) types its collection with a generic shape, so
 * s.doc(events) and ctx.db.find(events) lose the field types; this states them once until it does.
 */
export const AuditEventDoc = s.object({
  id: s.string(),
  __version: s.integer(),
  subjectType: s.enum(["dependency", "change", "policy", "settings", "consumer", "candidate", "sync"]),
  subjectId: s.string(),
  type: s.string(),
  actor: s.string(),
  actorType: s.string(),
  at: s.number(),
  seq: s.integer(),
  requestId: s.string(),
  data: s.optional(s.record(s.unknown())),
});
export type AuditEventRecord = { id: string; __version: number; subjectType: Subject; subjectId: string; type: string; actor: string; actorType: string; at: number; seq: number; requestId: string; data?: Record<string, unknown> };

type Subject = "dependency" | "change" | "policy" | "settings" | "consumer" | "candidate" | "sync";

export async function record(ctx: MutationCtx, subject: Subject, id: string, type: string, data?: Record<string, unknown>) {
  await events.record(ctx, { subject, id, type, ...(data ? { data } : {}) });
}

/** A reference's events and its changes' events, newest first. */
/** Every event, or one subject id's, newest first. */
export async function recentEvents(ctx: QueryCtx | MutationCtx, filter: { subjectId?: string; type?: string } = {}, limit = 200): Promise<AuditEventRecord[]> {
  return (await ctx.db.find(events, filter as never, { orderBy: [{ field: "at", direction: "desc" }, { field: "seq", direction: "desc" }], limit })) as unknown as AuditEventRecord[];
}

export async function referenceHistory(ctx: QueryCtx | MutationCtx, ref: string, limit = 200): Promise<AuditEventRecord[]> {
  const own = await events.history(ctx, "dependency", ref);
  const related = await ctx.db.find(changes, { ref }, { orderBy: [{ field: "number", direction: "desc" }], limit: 50 });
  const theirs = (await Promise.all(related.map((c) => events.history(ctx, "change", c.id)))).flat();
  // FeltKit's AuditEvent type omits __version; the stored records carry it (they are collection records).
  return [...own, ...theirs].sort((a, b) => b.at - a.at || b.seq - a.seq).slice(0, limit) as unknown as AuditEventRecord[];
}

/** The reference an event is about, when there is one: a reference subject's id. */
export const refOf = (e: { subjectType: string; subjectId: string }) => (e.subjectType === "dependency" ? e.subjectId : undefined);
