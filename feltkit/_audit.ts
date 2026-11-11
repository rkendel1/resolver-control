/**
 * The audit trail. Every state change records an event in the same transaction as the change,
 * so the trail cannot disagree with the state: both commit, or neither. Each event carries the
 * AppPort request id, which links it to FeltKit's activity record of the call (the capability,
 * the authorization decision, the writes FeltDB committed).
 */
import type { MutationCtx } from "@feltdb/feltkit";
import { events } from "./app.js";

type Subject = "dependency" | "change" | "policy" | "settings" | "consumer" | "candidate" | "sync";

export async function record(ctx: MutationCtx, subjectType: Subject, subjectId: string, type: string, data?: Record<string, unknown>, ref?: string) {
  const who = ctx.auth.requirePrincipal();
  // One stream per subject: writers about unrelated subjects never contend. Sequence names allow
  // letters, digits, "_", ".", ":" and "-"; a reference's "/" is mapped (a collision would only share an ordering).
  const seq = await ctx.db.sequence(`events:${subjectType}:${subjectId}`.replace(/[^A-Za-z0-9_.:-]/g, "_").slice(0, 128));
  await ctx.db.insert(events, {
    seq,
    subjectType,
    subjectId,
    ...(ref ? { ref } : {}),
    type,
    actor: who.id,
    actorType: who.type,
    at: Date.now(),
    requestId: ctx.requestId,
    ...(data ? { data } : {}),
  });
}
