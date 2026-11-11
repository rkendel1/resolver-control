/**
 * Demo governance metadata: policies, ownership and declared consumers for the references
 * `npm run demo:resolver` creates in a real Resolver. Nothing here touches Resolver, and
 * nothing claims a resolution: resolutions appear only once the component observes them.
 */
import { s } from "@feltdb/feltkit";
import { app, consumers, dependencies, policies, settings } from "./app.js";
import { record } from "./_audit.js";
import { parseRef } from "./_rules.js";

const POLICIES = [
  { environment: "dev", protected: false, approvalsRequired: 1 },
  { environment: "staging", protected: false, approvalsRequired: 1 },
  { environment: "prod", protected: true, approvalsRequired: 1 },
];

type Meta = { title: string; category: "ai" | "search" | "email" | "payments" | "identity" | "storage" | "credentials"; owner: string; criticality: "low" | "medium" | "high" | "critical"; changeClass: "runtime" | "adapter" | "migration" | "unknown"; contract?: string; changeClassNote?: string };
const PATHS: Record<string, Meta> = {
  "ai/default": { title: "Default chat model", category: "ai", owner: "platform-ai", criticality: "high", changeClass: "runtime", contract: "Chat completions through the provider's SDK; consumers read provider, model, endpoint and apiKey from Resolver's model() result." },
  "ai/fast": { title: "Fast model (classification, routing)", category: "ai", owner: "platform-ai", criticality: "medium", changeClass: "runtime", contract: "Chat completions; short prompts, low latency." },
  "llm/primary-key": { title: "Primary model provider key", category: "credentials", owner: "platform-security", criticality: "critical", changeClass: "runtime" },
  search: { title: "Search API", category: "search", owner: "discovery-team", criticality: "high", changeClass: "runtime", contract: "HTTP: GET {url}/search?q=… returning { hits: [{ id, title }] }." },
  email: { title: "Transactional email API", category: "email", owner: "growth-eng", criticality: "high", changeClass: "adapter", contract: "HTTP: POST {url}/send { to, subject, body }.", changeClassNote: "Providers with a different send API need the email adapter in notifications-service first." },
  payments: { title: "Payments provider", category: "payments", owner: "billing", criticality: "critical", changeClass: "migration", changeClassNote: "Stored payment methods are provider-specific tokens; switching providers needs a token migration, not just a new endpoint." },
};

export const seed = app.mutation({
  access: "demo.seed",
  args: { resolverUrl: s.optional(s.string()) },
  returns: s.object({ policies: s.integer(), dependencies: s.integer(), consumers: s.integer() }),
  capability: { name: "demo.seed", description: "Record demo governance metadata (policies, owners, criticality, declared consumers) for the demo references. Does not touch Resolver." },
  handler: async (ctx, { resolverUrl }) => {
    const who = ctx.auth.requirePrincipal();
    const now = Date.now();
    if (resolverUrl && !(await ctx.db.find(settings, {}, { limit: 1 })).length) {
      await ctx.db.insert(settings, { resolverUrl, namespaces: ["dev", "prod", "staging"], syncIntervalSeconds: 2, updatedBy: who.id, updatedAt: now });
    }
    let p = 0, d = 0, c = 0;
    for (const policy of POLICIES) {
      if ((await ctx.db.find(policies, { environment: policy.environment }, { limit: 1 })).length) continue;
      await ctx.db.insert(policies, { ...policy, frozen: false, updatedBy: who.id, updatedAt: now });
      p += 1;
    }
    for (const environment of ["staging", "prod"]) {
      for (const [path, meta] of Object.entries(PATHS)) {
        const ref = `ref://${environment}/${path}`;
        const parts = parseRef(ref) as { environment: string; path: string };
        if ((await ctx.db.find(dependencies, { ref }, { limit: 1 })).length) continue;
        await ctx.db.insert(dependencies, { ref, environment: parts.environment, path: parts.path, ...meta, createdBy: who.id, createdAt: now, updatedBy: who.id, updatedAt: now });
        d += 1;
      }
    }
    const declared: Array<[string, string, string]> = [
      ["ref://prod/ai/default", "support-assistant", "Drafts replies to customer tickets"],
      ["ref://prod/ai/default", "docs-search", "Answers questions over product docs"],
      ["ref://prod/ai/fast", "ticket-router", "Classifies incoming tickets"],
      ["ref://prod/search", "storefront", "Product search box"],
      ["ref://prod/email", "notifications-service", "Receipts and password resets"],
      ["ref://staging/ai/default", "support-assistant", "Staging deployment"],
    ];
    for (const [ref, application, usage] of declared) {
      if ((await ctx.db.find(consumers, { ref, application }, { limit: 1 })).length) continue;
      await ctx.db.insert(consumers, { ref, application, usage, source: "declared_by_operator", declaredBy: who.id, declaredAt: now });
      c += 1;
    }
    await record(ctx, "settings", "demo", "demo.seeded", { policies: p, dependencies: d, consumers: c });
    return { policies: p, dependencies: d, consumers: c };
  },
});
