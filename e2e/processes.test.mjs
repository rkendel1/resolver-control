/**
 * Everything as separate processes, nothing in-process:
 *   - Resolver: `@appport/resolver`'s own CLI (`resolver init`, `resolver serve`), seeded with its CLI;
 *   - Resolver Control: `feltkit dev`, its `resolver` component holding the executor key from
 *     FeltKit's credential custody (FELTKIT_CREDENTIAL_RESOLVER_API_KEY);
 *   - a consuming application (examples/consumer-app.mjs), started once, never restarted.
 * People act through the application's HTTP API with sessions minted by `feltkit session create`.
 *
 * Run: npm run test:e2e   (needs `npm install`; installs Resolver into .tmp/ on first run)
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { cpSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { resolverService } from "../tests/fixtures/resolver-service.mjs";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const children = [];

function run(command, args, options) {
  const child = spawn(command, args, { ...options, stdio: ["ignore", "pipe", "pipe"] });
  child.output = "";
  child.stdout.on("data", (d) => (child.output += d));
  child.stderr.on("data", (d) => (child.output += d));
  children.push(child);
  return child;
}

async function until(what, check, ms = 30_000) {
  const deadline = Date.now() + ms;
  let last;
  while (Date.now() < deadline) {
    try {
      last = await check();
      if (last) return last;
    } catch (error) {
      last = error;
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error(`timed out waiting for ${what}: ${last instanceof Error ? last.message : JSON.stringify(last)}`);
}

const port = () => 41000 + Math.floor(Math.random() * 9000);

test("a deployed consumer follows a governed change made through Resolver Control, across real processes", { timeout: 180_000 }, async () => {
  const { cli } = resolverService();
  const work = mkdtempSync(join(tmpdir(), "rc-e2e-"));
  const resolverDir = join(work, "resolver");
  const resolverPort = port();
  const appPort = port();
  const resolverUrl = `http://127.0.0.1:${resolverPort}`;
  try {
    // --- Resolver, as its operators run it.
    const adminKey = execFileSync(process.execPath, [cli, "init", "--dir", resolverDir, "--tenant", "acme"], { encoding: "utf8" }).trim().split("\n").at(-1);
    const resolverProcess = run(process.execPath, [cli, "serve", "--dir", resolverDir, "--port", String(resolverPort)], { env: { ...process.env, RESOLVER_ENV: "development", RESOLVER_LOG_LEVEL: "warn" } });
    await until("Resolver", async () => (await fetch(`${resolverUrl}/_resolver/ready`)).ok);
    const asAdmin = { ...process.env, RESOLVER_URL: resolverUrl, RESOLVER_API_KEY: adminKey };
    const resolver = (args, input) => execFileSync(process.execPath, [cli, ...args], { env: asAdmin, encoding: "utf8", ...(input ? { input } : {}) });
    const executorKey = resolver(["keys", "create", "resolver-control", "--grant", "read,write:ref://prod/*"]).trim().split("\n").at(-1);
    const consumerKey = resolver(["keys", "create", "support-assistant", "--grant", "read:ref://prod/*", "--grant", "read,reveal:ref://prod/llm/*"]).trim().split("\n").at(-1);
    resolver(["set", "ref://prod/llm/primary-key", "--kind", "secret", "--secret-stdin"], "sk-e2e-material-0123456789");
    resolver(["set", "ref://prod/ai/default", "--kind", "model", "--value", JSON.stringify({ provider: "openai", model: "gpt-4o", credential: "ref://prod/llm/primary-key" }), "--reason", "initial"]);

    // --- The consuming application: started once.
    const consumer = run(process.execPath, [join(ROOT, "examples/consumer-app.mjs")], { cwd: ROOT, env: { ...process.env, RESOLVER_URL: resolverUrl, RESOLVER_API_KEY: consumerKey, CONSUMER_REFS: "ref://prod/ai/default", CONSUMER_INTERVAL_MS: "200" } });
    const consumerSays = () => consumer.output.trim().split("\n").filter((l) => l.startsWith("{")).map((l) => JSON.parse(l));
    await until("the consumer's first resolution", () => consumerSays().some((l) => l.uses === "openai/gpt-4o" && l.revision === 1));

    // --- Resolver Control, from a copy of this project (its own development state).
    const project = join(work, "app");
    for (const entry of ["feltkit", "component", "src", "public", "index.html", "package.json", "tsconfig.json", "vite.config.ts"]) cpSync(join(ROOT, entry), join(project, entry), { recursive: true });
    symlinkSync(join(ROOT, "node_modules"), join(project, "node_modules"), "dir");
    const feltkit = join(ROOT, "node_modules/.bin/feltkit");
    const app = run(feltkit, ["dev", "--port", String(appPort)], { cwd: project, env: { ...process.env, FELTKIT_CREDENTIAL_RESOLVER_API_KEY: executorKey, BROWSER: "none" } });
    const appUrl = `http://127.0.0.1:${appPort}`;
    await until("Resolver Control", async () => (await fetch(`${appUrl}/_feltkit/health`)).status < 500);
    const session = (id, roles) => {
      const out = execFileSync(feltkit, ["session", "create", "--id", id, ...roles.flatMap((r) => ["--role", r]), "--type", "user"], { cwd: project, encoding: "utf8" });
      return out.match(/fks_[A-Za-z0-9_-]+/)[0];
    };
    const call = async (token, kind, name, args) => {
      const response = await fetch(`${appUrl}/api/${kind}/${name}`, { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: JSON.stringify({ args }) });
      const body = await response.json();
      if (!body.ok) throw Object.assign(new Error(body.error?.message ?? JSON.stringify(body)), { code: body.error?.code });
      return body.value;
    };
    const ada = session("ada", ["admin", "prod_approver"]);
    const grace = session("grace", ["engineer"]);
    const linus = session("linus", ["prod_approver"]);

    await call(ada, "mutation", "settings:set", { resolverUrl, namespaces: ["prod"], syncIntervalSeconds: 1 });
    await call(ada, "mutation", "demo:seed", {});
    const observed = await until("the component's first observation", async () => (await call(ada, "query", "catalog:inventory", {})).find((r) => r.ref === "ref://prod/ai/default" && r.revision === 1));
    assert.equal(observed.governance, "governed");

    const change = await call(grace, "mutation", "changes:proposeRetarget", { ref: "ref://prod/ai/default", basedOnRevision: 1, binding: { value: { provider: "anthropic", model: "claude-sonnet-5-5", credential: "ref://prod/llm/primary-key" } }, reason: "e2e: move default chat to Claude" });
    await until("validation", async () => (await call(ada, "query", "changes:get", { id: change.id })).change.status === "ready");
    await assert.rejects(call(grace, "mutation", "changes:approve", { id: change.id }), /Missing permission: changes.approve/);
    await call(linus, "mutation", "changes:approve", { id: change.id, note: "e2e approval" });
    const done = await until("verification", async () => {
      const c = (await call(ada, "query", "changes:get", { id: change.id })).change;
      return ["verified", "failed", "unknown", "superseded"].includes(c.status) ? c : null;
    });
    assert.equal(done.status, "verified", JSON.stringify(done.execution));
    assert.equal(done.verification.correlated, true);

    // The consumer process, never restarted, now uses the new model at the new revision.
    const switched = await until("the consumer to follow", () => consumerSays().find((l) => l.uses === "anthropic/claude-sonnet-5-5" && l.revision === 2));
    assert.equal(switched.pid, consumer.pid, "the same process");
    assert.equal(switched.hasKey, true);
    assert.ok(!consumer.output.includes("sk-e2e-material"), "the consumer never prints the key");
    assert.ok(!app.output.includes("sk-e2e-material"), "Resolver Control never handles the key");

    // Resolver's own CLI shows the change, by its correlation tag.
    const history = JSON.parse(resolver(["history", "ref://prod/ai/default"]));
    assert.match(history.entries.at(-1).reason, new RegExp(`CHG-${change.number} ${change.id}`));

    // An agent over MCP (FeltKit's agent endpoint): discovers the capabilities, inspects, and is refused approval.
    const agentToken = execFileSync(feltkit, ["session", "create", "--id", "ops-agent", "--role", "agent", "--type", "agent"], { cwd: project, encoding: "utf8" }).match(/fks_[A-Za-z0-9_-]+/)[0];
    const rpc = async (method, params) => (await (await fetch(`${appUrl}/mcp`, { method: "POST", headers: { authorization: `Bearer ${agentToken}`, "content-type": "application/json", accept: "application/json, text/event-stream" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) })).json()).result;
    await rpc("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "e2e", version: "1" } });
    const tools = (await rpc("tools/list", {})).tools;
    const tool = (capability) => tools.find((x) => x.name.replace(/[_.-]/g, ".") === capability)?.name;
    for (const capability of ["dependencies.list", "dependencies.inspect", "changes.propose", "changes.approve", "insights.list"]) assert.ok(tool(capability), `MCP exposes ${capability}: ${tools.map((x) => x.name).join(", ")}`);
    const listed = await rpc("tools/call", { name: tool("dependencies.list"), arguments: {} });
    assert.ok(!listed.isError && JSON.stringify(listed).includes("ref://prod/ai/default"));
    const approval = await rpc("tools/call", { name: tool("changes.approve"), arguments: { id: change.id } });
    assert.equal(approval.isError, true, "an agent cannot approve");

    // The component reports its health into the application's.
    const health = await (await fetch(`${appUrl}/_feltkit/health`)).json();
    assert.equal(health.components.resolver.state, "ready");
    writeFileSync(join(work, "evidence.json"), JSON.stringify({ change: done, consumer: switched, history: history.entries }, null, 2));
    console.log(`evidence: ${join(work, "evidence.json")}`);
    void resolverProcess;
  } finally {
    for (const child of children.reverse()) child.kill("SIGTERM");
    await new Promise((r) => setTimeout(r, 500));
  }
});
