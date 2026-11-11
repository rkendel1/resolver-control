import { s } from "@feltdb/feltkit";
import { app, events } from "./app.js";

export const list = app.query({
  access: "activity.read",
  args: { ref: s.optional(s.string()), subjectId: s.optional(s.string()), limit: s.optional(s.integer({ minimum: 1, maximum: 500 })) },
  returns: s.array(s.doc(events)),
  capability: { name: "activity.list", description: "The append-only audit trail, newest first: what happened, who did it, from which AppPort request." },
  handler: (ctx, { ref, subjectId, limit }) =>
    ctx.db.find(events, { ...(ref ? { ref } : {}), ...(subjectId ? { subjectId } : {}) }, { orderBy: [{ field: "at", direction: "desc" }], limit: limit ?? 200 }),
});
