#!/usr/bin/env node
/**
 * The real stack, locally, in one command:
 *   1. Resolver (`@appport/resolver`, its own CLI), state in .tmp/demo/resolver;
 *   2. references an operator would create: provider keys, models, search, email and payments
 *      endpoints, in staging and prod;
 *   3. an executor key for Resolver Control (read + write on staging and prod; nothing on dev),
 *      and a consumer key for examples/consumer-app.mjs (read; reveal on provider keys);
 *   4. Resolver Control under `feltkit dev`, its component given the executor key through FeltKit's
 *      credential custody (FELTKIT_CREDENTIAL_RESOLVER_API_KEY), never through the application's data.
 *
 *   npm run demo            then open the printed URL, Settings → "Load demo policies, owners and consumers"
 *   npm run demo -- --consumer   also runs the consumer app, printing what it resolves every 2 s
 *
 * Keys are written to .tmp/demo (gitignored, mode 0600) so a restart reuses them; they are never printed.
 */
import { execFileSync, spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { fileURLToPath } from "node:url";
import { resolverService } from "../tests/fixtures/resolver-service.mjs";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const DIR = join(ROOT, ".tmp", "demo");
const RESOLVER_PORT = Number(process.env.RESOLVER_PORT ?? 4300);
const APP_PORT = Number(process.env.PORT ?? 3000);
const resolverUrl = `http://127.0.0.1:${RESOLVER_PORT}`;
const { cli } = resolverService();
mkdirSync(DIR, { recursive: true });

const keyFile = (name) => join(DIR, `${name}.key`);
const saved = (name) => (existsSync(keyFile(name)) ? readFileSync(keyFile(name), "utf8").trim() : null);
const save = (name, value) => writeFileSync(keyFile(name), value, { mode: 0o600 });
const children = [];
const stop = () => {
  for (const child of children) child.kill("SIGTERM");
  process.exit(0);
};
process.on("SIGINT", stop);
process.on("SIGTERM", stop);

let admin = saved("admin");
if (!admin) {
  admin = execFileSync(process.execPath, [cli, "init", "--dir", join(DIR, "resolver"), "--tenant", "demo"], { encoding: "utf8" }).trim().split("\n").at(-1);
  save("admin", admin);
}
const resolverProcess = spawn(process.execPath, [cli, "serve", "--dir", join(DIR, "resolver"), "--port", String(RESOLVER_PORT)], { env: { ...process.env, RESOLVER_ENV: "development", RESOLVER_LOG_LEVEL: "warn" }, stdio: "inherit" });
children.push(resolverProcess);
for (let i = 0; i < 100; i++) {
  try {
    if ((await fetch(`${resolverUrl}/_resolver/ready`)).ok) break;
  } catch {}
  await new Promise((r) => setTimeout(r, 100));
}

const env = { ...process.env, RESOLVER_URL: resolverUrl, RESOLVER_API_KEY: admin };
const resolver = (args, input) => execFileSync(process.execPath, [cli, ...args], { env, encoding: "utf8", ...(input !== undefined ? { input } : {}) });
const exists = (ref) => JSON.parse(resolver(["list", ref.slice(0, ref.lastIndexOf("/") + 1)])).refs.some((r) => r.ref === ref);
const setOnce = (ref, args, input) => {
  if (!exists(ref)) resolver(["set", ref, ...args], input);
};

for (const environment of ["staging", "prod"]) {
  setOnce(`ref://${environment}/llm/primary-key`, ["--kind", "secret", "--secret-stdin"], `demo-${environment}-${randomBytes(12).toString("hex")}`);
  setOnce(`ref://${environment}/ai/default`, ["--kind", "model", "--value", JSON.stringify({ provider: "openai", model: "gpt-4o", credential: `ref://${environment}/llm/primary-key` }), "--reason", "initial model", "--ttl", "60"]);
  setOnce(`ref://${environment}/ai/fast`, ["--kind", "model", "--value", JSON.stringify({ provider: "openai", model: "gpt-4o-mini", credential: `ref://${environment}/llm/primary-key` }), "--reason", "initial fast model"]);
  setOnce(`ref://${environment}/search`, ["--kind", "endpoint", "--value", JSON.stringify({ url: environment === "prod" ? "https://search-a.example.com" : "https://search-b.example.com" }), "--reason", "initial search provider"]);
  setOnce(`ref://${environment}/email`, ["--kind", "endpoint", "--value", JSON.stringify({ url: "https://mail-a.example.com" }), "--reason", "initial email provider"]);
  setOnce(`ref://${environment}/payments`, ["--kind", "endpoint", "--value", JSON.stringify({ url: "https://payments-a.example.com" }), "--reason", "initial payments provider"]);
}
let executor = saved("executor");
if (!executor) {
  executor = resolver(["keys", "create", "resolver-control", "--grant", "read,write:ref://staging/*", "--grant", "read,write:ref://prod/*"]).trim().split("\n").at(-1);
  save("executor", executor);
}
let consumer = saved("consumer");
if (!consumer) {
  consumer = resolver(["keys", "create", "support-assistant", "--grant", "read:ref://prod/*", "--grant", "read,reveal:ref://prod/llm/*"]).trim().split("\n").at(-1);
  save("consumer", consumer);
}

console.log(`\nResolver           ${resolverUrl}   (its own pages: ${resolverUrl}/resolver; sign in with the key in .tmp/demo/admin.key)`);
console.log(`Resolver Control   starting on http://localhost:${APP_PORT}\n`);
console.log(`In the app: Settings → origin ${resolverUrl}, environments "staging, prod" → Save; then "Load demo policies, owners and consumers".\n`);

const feltkit = join(ROOT, "node_modules", ".bin", "feltkit");
children.push(spawn(feltkit, ["dev", "--port", String(APP_PORT)], { cwd: ROOT, env: { ...process.env, FELTKIT_CREDENTIAL_RESOLVER_API_KEY: executor }, stdio: "inherit" }));
if (process.argv.includes("--consumer")) {
  children.push(spawn(process.execPath, [join(ROOT, "examples", "consumer-app.mjs")], { cwd: ROOT, env: { ...process.env, RESOLVER_URL: resolverUrl, RESOLVER_API_KEY: consumer, CONSUMER_INTERVAL_MS: "2000" }, stdio: "inherit" }));
}
