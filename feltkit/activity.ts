import { s } from "@feltdb/feltkit";
import { app } from "./app.js";
import { AuditEventDoc, recentEvents, referenceHistory } from "./_audit.js";

export const list = app.query({
  access: "activity.read",
  args: { ref: s.optional(s.string()), subjectId: s.optional(s.string()), limit: s.optional(s.integer({ minimum: 1, maximum: 500 })) },
  returns: s.array(AuditEventDoc),
  capability: { name: "activity.list", description: "The append-only audit trail, newest first: what happened, who did it, from which AppPort request. For a reference: its own events and its changes'." },
  handler: (ctx, { ref, subjectId, limit }) =>
    ref
      ? referenceHistory(ctx, ref, limit ?? 200)
      : recentEvents(ctx, subjectId ? { subjectId } : {}, limit ?? 200),
});
