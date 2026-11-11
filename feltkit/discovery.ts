/**
 * Discovery: operational decisions embedded in code (a hardcoded model id, a provider URL, an
 * API host read from the environment) that could become explicit runtime references. Findings
 * come from the deterministic scanner (`npm run discover`), a person, or an agent; each keeps
 * its location and pattern as evidence. A finding is a candidate, never a dependency: adopting
 * one records what was decided; making it resolvable still needs a reference in Resolver and a
 * code change in the consumer to resolve it.
 */
import { fail, s } from "@feltdb/feltkit";
import { app, candidates, CATEGORIES, KINDS } from "./app.js";
import { record } from "./_audit.js";
import { parseRef } from "./_rules.js";

const Candidate = s.doc(candidates);

export const submit = app.mutation({
  access: "discovery.write",
  args: {
    items: s.array(s.object({
      repository: s.string({ minLength: 1, maxLength: 200 }),
      location: s.string({ minLength: 1, maxLength: 400 }),
      category: s.enum(CATEGORIES),
      pattern: s.string({ maxLength: 80 }),
      excerpt: s.string({ maxLength: 300 }),
      suggestedRef: s.optional(s.string({ maxLength: 256 })),
      suggestedKind: s.enum(KINDS),
      rationale: s.string({ maxLength: 1000 }),
      fingerprint: s.string({ minLength: 8, maxLength: 128 }),
    }), { maxItems: 200 }),
  },
  returns: s.object({ added: s.integer(), known: s.integer() }),
  capability: { name: "discovery.submit", description: "Submit candidate dependencies found in code (location, pattern, excerpt with secrets redacted, suggested reference). Duplicates by fingerprint are ignored." },
  handler: async (ctx, { items }) => {
    const who = ctx.auth.requirePrincipal();
    let added = 0;
    for (const item of items) {
      if (item.suggestedRef && "error" in parseRef(item.suggestedRef)) fail("INVALID_ARGUMENT", `${item.suggestedRef} is not a reference name.`);
      if ((await ctx.db.find(candidates, { fingerprint: item.fingerprint }, { limit: 1 })).length) continue;
      const id = await ctx.db.insert(candidates, { ...item, source: who.type === "user" ? "person" : who.type === "agent" ? "agent" : "scan", status: "open", submittedBy: who.id, submittedAt: Date.now() });
      await record(ctx, "candidate", id, "candidate.submitted", { location: item.location, pattern: item.pattern, suggestedRef: item.suggestedRef ?? null });
      added += 1;
    }
    return { added, known: items.length - added };
  },
});

export const list = app.query({
  access: "discovery.read",
  args: { status: s.optional(s.enum(["open", "adopted", "dismissed"])) },
  returns: s.array(Candidate),
  capability: { name: "discovery.list", description: "Candidate dependencies discovered in code." },
  handler: (ctx, { status }) => ctx.db.find(candidates, status ? { status } : {}, { orderBy: [{ field: "submittedAt", direction: "desc" }], limit: 500 }),
});

export const resolve = app.mutation({
  access: "discovery.write",
  args: { id: s.string(), status: s.enum(["adopted", "dismissed"]), note: s.optional(s.string({ maxLength: 1000 })), ref: s.optional(s.string()) },
  returns: Candidate,
  capability: { name: "discovery.resolve", description: "Adopt a candidate (naming the reference it becomes) or dismiss it, with a note." },
  handler: async (ctx, { id, status, note, ref }) => {
    const who = ctx.auth.requirePrincipal();
    const candidate = await ctx.db.get(candidates, id);
    if (!candidate) fail("NOT_FOUND", `No candidate ${id}.`);
    if (candidate.status !== "open") fail("FAILED_PRECONDITION", `Already ${candidate.status}.`);
    if (ref && "error" in parseRef(ref)) fail("INVALID_ARGUMENT", `${ref} is not a reference name.`);
    if (status === "adopted" && !ref && !candidate.suggestedRef) fail("INVALID_ARGUMENT", "Name the reference the candidate becomes.");
    const resolution = { by: who.id, at: Date.now(), ...(note ? { note } : {}), ...(status === "adopted" ? { ref: ref ?? candidate.suggestedRef! } : {}) };
    await ctx.db.patch(candidates, id, { status, resolution });
    await record(ctx, "candidate", id, `candidate.${status}`, { location: candidate.location, ref: resolution.ref ?? null, note: note ?? null });
    return (await ctx.db.get(candidates, id))!;
  },
});
