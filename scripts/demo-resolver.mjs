/**
 * Resolver for the public demo: runs `@appport/resolver` beside the app in the same container, with demo
 * references in staging and prod, and gives the app an executor key, so the demo opens already connected.
 * State lives under DEMO_RESOLVER_DIR (default: on the volume), so a redeploy keeps it.
 * Used by scripts/demo-server.mjs when the image ships Resolver (RESOLVER_SERVICE_DIR; scripts/demo-artifact.mjs).
 * DEMO ONLY: the references hold made-up values.
 */
import { execFileSync, spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { randomBytes } from "node:crypto";

export async function startDemoResolver(serviceDir, stateDir, port = 4300) {
  const cli = join(serviceDir, "node_modules", "@appport", "resolver", "dist", "cli.js");
  if (!existsSync(cli)) return null;
  mkdirSync(stateDir, { recursive: true });
  const dir = join(stateDir, "resolver");
  const url = `http://127.0.0.1:${port}`;
  const keyFile = (n) => join(stateDir, `${n}.key`);
  const saved = (n) => (existsSync(keyFile(n)) ? readFileSync(keyFile(n), "utf8").trim() : null);
  const save = (n, v) => writeFileSync(keyFile(n), v, { mode: 0o600 });
  const run = (args, env, input) => execFileSync(process.execPath, [cli, ...args], { env: { ...process.env, ...env }, encoding: "utf8", ...(input !== undefined ? { input } : {}) });

  let admin = saved("admin");
  if (!admin) {
    admin = run(["init", "--dir", dir, "--tenant", "demo"]).trim().split("\n").at(-1);
    save("admin", admin);
  }
  const child = spawn(process.execPath, [cli, "serve", "--dir", dir, "--port", String(port)], { env: { ...process.env, RESOLVER_ENV: "development", RESOLVER_LOG_LEVEL: "warn" }, stdio: "inherit" });
  for (let i = 0; ; i++) {
    try {
      if ((await fetch(`${url}/_resolver/ready`)).ok) break;
    } catch {}
    if (i > 200) throw new Error("demo Resolver did not become ready");
    await new Promise((r) => setTimeout(r, 100));
  }
  const env = { RESOLVER_URL: url, RESOLVER_API_KEY: admin };
  const resolver = (args, input) => run(args, env, input);
  const exists = (ref) => JSON.parse(resolver(["list", ref.slice(0, ref.lastIndexOf("/") + 1)])).refs.some((r) => r.ref === ref);
  const setOnce = (ref, args, input) => {
    if (!exists(ref)) resolver(["set", ref, ...args], input);
  };
  for (const e of ["staging", "prod"]) {
    setOnce(`ref://${e}/llm/primary-key`, ["--kind", "secret", "--secret-stdin"], `demo-${e}-${randomBytes(12).toString("hex")}`);
    setOnce(`ref://${e}/ai/default`, ["--kind", "model", "--value", JSON.stringify({ provider: "openai", model: "gpt-4o", credential: `ref://${e}/llm/primary-key` }), "--reason", "initial model", "--ttl", "60"]);
    setOnce(`ref://${e}/ai/fast`, ["--kind", "model", "--value", JSON.stringify({ provider: "openai", model: "gpt-4o-mini", credential: `ref://${e}/llm/primary-key` }), "--reason", "initial fast model"]);
    setOnce(`ref://${e}/search`, ["--kind", "endpoint", "--value", JSON.stringify({ url: e === "prod" ? "https://search-a.example.com" : "https://search-b.example.com" }), "--reason", "initial search provider"]);
    setOnce(`ref://${e}/email`, ["--kind", "endpoint", "--value", JSON.stringify({ url: "https://mail-a.example.com" }), "--reason", "initial email provider"]);
    setOnce(`ref://${e}/payments`, ["--kind", "endpoint", "--value", JSON.stringify({ url: "https://payments-a.example.com" }), "--reason", "initial payments provider"]);
  }
  let executor = saved("executor");
  if (!executor) {
    executor = resolver(["keys", "create", "resolver-control", "--grant", "read,write:ref://staging/*", "--grant", "read,write:ref://prod/*"]).trim().split("\n").at(-1);
    save("executor", executor);
  }
  return { url, executor, child };
}
