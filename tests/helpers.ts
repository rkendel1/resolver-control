/**
 * Test helpers: the real Resolver (`@appport/resolver`, in process, its own service install), and
 * the resolver engine bound to a test app as the component principal, calling functions by name
 * exactly as the component host does.
 */
import { randomBytes } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ResolverClient } from "@appport/resolver-client";
import type { Caller } from "@feltdb/feltkit/testing";
import type { PrincipalInput } from "@feltdb/feltkit";
import { ResolverEngine, type Connect } from "../component/engine.js";
import { loadResolver } from "./fixtures/resolver-service.mjs";

export const EXECUTOR = { id: "component:resolver", type: "service" as const, roles: ["executor"] };
const QUERIES = new Set(["settings:get", "observations:index", "changes:work"]);

export interface RealResolver {
  url: string;
  admin: ResolverClient;
  /** The executor's key: read and write on the given patterns, nothing else. */
  executorKey: string;
  executorPrincipal: string;
  /** A consuming application's key: read + reveal, no write. */
  consumerKey: string;
  /** The in-process Resolver runtime, for operator actions (policies) in tests. */
  runtime: unknown;
  close(): Promise<void>;
}

export async function startResolver(options: { executorWrite?: string[]; executorRead?: string[] } = {}): Promise<RealResolver> {
  const dir = mkdtempSync(join(tmpdir(), "rc-resolver-"));
  const { createResolverRuntime } = await loadResolver();
  const runtime = await createResolverRuntime({
    state: { memory: true },
    environment: "development",
    vaultDirectory: join(dir, "vault"),
    vaultKey: randomBytes(32),
    verifierKey: randomBytes(32).toString("hex"),
  });
  const server = await runtime.serve({ port: 0 });
  const url = server.url.replace(/\/$/, "");
  const operator = runtime.operator("acme");
  const created = await runtime.resolver.createKey(operator, { name: "admin" });
  await runtime.resolver.grant(operator, { subject: created.principal, actions: ["admin", "read", "write", "reveal"], pattern: "*" });
  const admin = await ResolverClient.connect({ url, apiKey: created.secret, live: false });

  const executor = await admin.createKey("resolver-control-executor");
  for (const pattern of options.executorRead ?? ["ref://dev/*", "ref://staging/*", "ref://prod/*"]) await admin.grant(executor.principal, ["read"], pattern);
  for (const pattern of options.executorWrite ?? ["ref://dev/*", "ref://staging/*", "ref://prod/*"]) await admin.grant(executor.principal, ["write"], pattern);

  const consumer = await admin.createKey("support-assistant");
  await admin.grant(consumer.principal, ["read"], "ref://prod/*");
  await admin.grant(consumer.principal, ["read", "reveal"], "ref://prod/llm/*");

  return {
    url,
    admin,
    runtime,
    executorKey: executor.secret,
    executorPrincipal: executor.principal,
    consumerKey: consumer.secret,
    async close() {
      await admin.close().catch(() => undefined);
      await runtime.close();
    },
  };
}

/** Seeds Resolver as an operator would with its CLI: a provider key, two models, a search and an email endpoint. */
export async function seedResolver(admin: ResolverClient) {
  await admin.put({ ref: "ref://prod/llm/primary-key", kind: "secret", secret: `sk-test-${randomBytes(12).toString("hex")}`, expectedRevision: 0, reason: "initial key" });
  await admin.put({ ref: "ref://prod/ai/default", kind: "model", binding: { value: { provider: "openai", model: "gpt-4o", credential: "ref://prod/llm/primary-key" } }, expectedRevision: 0, reason: "initial model", ttlSeconds: 300 });
  await admin.put({ ref: "ref://prod/search", kind: "endpoint", binding: { value: { url: "https://search-a.example.com" } }, expectedRevision: 0, reason: "initial search provider" });
  await admin.put({ ref: "ref://staging/search", kind: "endpoint", binding: { value: { url: "https://search-b.example.com" } }, expectedRevision: 0, reason: "trying provider B" });
}

/** Binds the engine to any test host (FeltKit runtime or the compiled artifact) as the component principal. */
export function engineFor(t: { as(who: string | PrincipalInput): Caller }, resolver: { url: string; executorKey: string }, options: { connect?: Connect; signerToken?: string; now?: () => number; consumersIntervalMs?: number } = {}) {
  const caller = t.as(EXECUTOR);
  return new ResolverEngine({
    call: (name, args) => {
      const ref = { name } as never;
      return (QUERIES.has(name) ? caller.query(ref, args as never) : caller.mutation(ref, args as never)) as never;
    },
    apiKey: async () => resolver.executorKey,
    ...(options.connect ? { connect: options.connect } : {}),
    ...(options.signerToken ? { signerToken: async () => options.signerToken! } : {}),
    ...(options.now ? { now: options.now } : {}),
    ...(options.consumersIntervalMs !== undefined ? { consumersIntervalMs: options.consumersIntervalMs } : {}),
  });
}

/** Run the engine until nothing is left to do (bounded). */
export async function settle(engine: ResolverEngine, passes = 4) {
  for (let i = 0; i < passes; i++) await engine.tick();
}
