/**
 * The governance loop end to end, every part its own process:
 *   - Resolver 0.4.0 (`resolver serve`), with prod under a mutation policy and the signer's public key
 *     trusted, both set by its host operator with its CLI (`resolver policy set`, `resolver signing-key add`);
 *   - Resolver Control (`feltkit dev`): its component holds the executor's Resolver key and the signer
 *     client token (FeltKit credential custody), never the signing key;
 *   - the approval signer (signer/server.ts): holds the private key; reads Resolver Control as its own
 *     read-only session;
 *   - a consuming application registered with Resolver, reporting what it uses.
 *
 * Run: npm run test:e2e
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { cpSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolverService } from "../tests/fixtures/resolver-service.mjs";
import { ROOT, port, run, stopAll, until } from "./harness.mjs";

test("governed change across processes: approval in Resolver Control, authorization from the signer, enforcement and evidence in Resolver, adoption read back", { timeout: 240_000 }, async () => {
  const { cli } = resolverService();
  const work = mkdtempSync(join(tmpdir(), "rc-gov-e2e-"));
  const resolverDir = join(work, "resolver");
  const [resolverPort, appPort, signerPort] = [port(), port(), port()];
  const resolverUrl = `http://127.0.0.1:${resolverPort}`;
  const appUrl = `http://127.0.0.1:${appPort}`;
  const signerUrl = `http://127.0.0.1:${signerPort}`;
  try {
    // --- Resolver, seeded before governance (the operator's own setup).
    const adminKey = execFileSync(process.execPath, [cli, "init", "--dir", resolverDir, "--tenant", "acme"], { encoding: "utf8" }).trim().split("\n").at(-1);
    // State opened shared: the host operator's CLI runs beside the serving process on the state host.
    const shared = { ...process.env, RESOLVER_STATE_SHARED: "1" };
    run(process.execPath, [cli, "serve", "--dir", resolverDir, "--port", String(resolverPort)], { env: { ...shared, RESOLVER_ENV: "development", RESOLVER_LOG_LEVEL: "warn" } });
    await until("Resolver", async () => (await fetch(`${resolverUrl}/_resolver/ready`)).ok);
    const asAdmin = { ...process.env, RESOLVER_URL: resolverUrl, RESOLVER_API_KEY: adminKey };
    const resolver = (args, input) => execFileSync(process.execPath, [cli, ...args], { env: asAdmin, encoding: "utf8", ...(input ? { input } : {}) });
    const operator = (args) => execFileSync(process.execPath, [cli, ...args, "--dir", resolverDir, "--tenant", "acme"], { env: shared, encoding: "utf8" });
    const executorKey = resolver(["keys", "create", "resolver-control", "--grant", "read,write:ref://prod/*"]).trim().split("\n").at(-1);
    const consumerKey = resolver(["keys", "create", "support-assistant", "--grant", "read:ref://prod/*"]).trim().split("\n").at(-1);
    resolver(["set", "ref://prod/search", "--kind", "endpoint", "--value", JSON.stringify({ url: "https://search-a.example.com" }), "--reason", "initial"]);

    // --- The signer's key pair. Only the public key leaves the signer's custody.
    const keyFile = join(work, "signer-key.pem");
    const { publicKey } = JSON.parse(execFileSync(process.execPath, ["--import", "tsx", join(ROOT, "signer/server.ts"), "--generate", keyFile], { cwd: ROOT, encoding: "utf8" }));

    // --- The host operator governs prod and trusts the signer's key.
    operator(["policy", "set", "prod", "--pattern", "ref://prod/*", "--operations", "put,put-secret,rollback,revoke", "--issuer", "resolver-control", "--max-validity", "600", "--reason", "prod changes need an approved change"]);
    operator(["signing-key", "add", "rc-e2e-1", "--issuer", "resolver-control", "--public-key", publicKey, "--reason", "Resolver Control approval signer"]);
    // Governed now: the admin key alone can no longer change prod.
    assert.throws(() => resolver(["set", "ref://prod/search", "--value", JSON.stringify({ url: "https://search-x.example.com" }), "--reason", "direct"]), /authorization-required|needs a change authorization/);

    // --- The consuming application, registered with Resolver.
    const consumer = run(process.execPath, [join(ROOT, "examples/consumer-app.mjs")], { cwd: ROOT, env: { ...process.env, RESOLVER_URL: resolverUrl, RESOLVER_API_KEY: consumerKey, CONSUMER_REFS: "ref://prod/search", CONSUMER_INTERVAL_MS: "200", CONSUMER_APPLICATION: "support-assistant", CONSUMER_ENVIRONMENT: "prod", CONSUMER_REPORT: "1" } });
    const consumerSays = () => consumer.output.trim().split("\n").filter((l) => l.startsWith("{")).map((l) => JSON.parse(l));
    await until("the consumer's first resolution", () => consumerSays().some((l) => l.revision === 1));

    // --- Resolver Control.
    const project = join(work, "app");
    for (const entry of ["feltkit", "component", "src", "public", "index.html", "package.json", "tsconfig.json", "vite.config.ts"]) cpSync(join(ROOT, entry), join(project, entry), { recursive: true });
    symlinkSync(join(ROOT, "node_modules"), join(project, "node_modules"), "dir");
    const clientToken = randomBytes(24).toString("base64url");
    const feltkit = join(ROOT, "node_modules/.bin/feltkit");
    const app = run(feltkit, ["dev", "--port", String(appPort)], { cwd: project, env: { ...process.env, FELTKIT_CREDENTIAL_RESOLVER_API_KEY: executorKey, FELTKIT_CREDENTIAL_APPROVAL_SIGNER_TOKEN: clientToken, BROWSER: "none" } });
    await until("Resolver Control", async () => (await fetch(`${appUrl}/_feltkit/health`)).status < 500);
    const session = (id, roles, type = "user") => execFileSync(feltkit, ["session", "create", "--id", id, ...roles.flatMap((r) => ["--role", r]), "--type", type], { cwd: project, encoding: "utf8" }).match(/fks_[A-Za-z0-9_-]+/)[0];
    const call = async (token, kind, name, args) => {
      const response = await fetch(`${appUrl}/api/${kind}/${name}`, { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: JSON.stringify({ args }) });
      const body = await response.json();
      if (!body.ok) throw Object.assign(new Error(body.error?.message ?? JSON.stringify(body)), { code: body.error?.code });
      return body.value;
    };
    const ada = session("ada", ["admin", "prod_approver"]);
    const grace = session("grace", ["engineer"]);
    const linus = session("linus", ["prod_approver"]);

    // --- The signer: its own process, its own read-only session in Resolver Control.
    const signerSession = session("approval-signer", ["signer"], "service");
    writeFileSync(join(work, "signer-client-token"), clientToken, { mode: 0o600 });
    writeFileSync(join(work, "signer-rc-token"), signerSession, { mode: 0o600 });
    const signer = run(process.execPath, ["--import", "tsx", join(ROOT, "signer/server.ts")], {
      cwd: ROOT,
      env: { ...process.env, PORT: String(signerPort), SIGNER_PRIVATE_KEY_FILE: keyFile, SIGNER_KID: "rc-e2e-1", SIGNER_TENANT: "acme", SIGNER_SCOPE: "ref://prod/*", SIGNER_CLIENT_TOKEN_FILE: join(work, "signer-client-token"), RC_URL: appUrl, RC_TOKEN_FILE: join(work, "signer-rc-token") },
    });
    await until("the signer", async () => (await fetch(`${signerUrl}/ready`)).ok);
    assert.equal((await (await fetch(`${signerUrl}/key`)).json()).publicKey, publicKey);
    // The signer refuses a caller without the client token.
    assert.equal((await fetch(`${signerUrl}/sign`, { method: "POST", body: JSON.stringify({ changeId: "x", attempt: 1 }) })).status, 401);

    await call(ada, "mutation", "settings:set", { resolverUrl, namespaces: ["prod"], syncIntervalSeconds: 1, signerUrl });
    await call(ada, "mutation", "demo:seed", {});
    await until("the component's first observation", async () => (await call(ada, "query", "catalog:inventory", {})).find((r) => r.ref === "ref://prod/search" && r.revision === 1));

    // --- The governance loop.
    const change = await call(grace, "mutation", "changes:proposeRetarget", { ref: "ref://prod/search", basedOnRevision: 1, binding: { value: { url: "https://search-b.example.com" } }, reason: "e2e: governed switch to provider B" });
    await until("validation", async () => (await call(ada, "query", "changes:get", { id: change.id })).change.status === "ready");
    await call(linus, "mutation", "changes:approve", { id: change.id, note: "e2e approval" });
    const done = await until("verification", async () => {
      const c = (await call(ada, "query", "changes:get", { id: change.id })).change;
      return ["verified", "failed", "unknown", "superseded"].includes(c.status) ? c : null;
    }, 60_000);
    assert.equal(done.status, "verified", JSON.stringify(done.execution));
    assert.equal(done.verification.governance.mode, "authorized");
    assert.equal(done.verification.governance.jti, `${change.id}.1`);
    assert.equal(done.verification.checks.find((c) => c.id === "authorization").outcome, "pass");

    // Resolver's own record, through its CLI: the revision names the authorization and the approver.
    const history = JSON.parse(resolver(["history", "ref://prod/search"]));
    const entry = history.entries.at(-1);
    assert.equal(entry.revision, 2);
    assert.equal(entry.governance.mode, "authorized");
    assert.equal(entry.governance.issuer, "resolver-control");
    assert.equal(entry.governance.decision, change.id);
    assert.deepEqual(entry.governance.approvers, ["linus"]);

    // The consumer, never restarted, follows and reports; Resolver Control reads adoption back, by basis.
    await until("the consumer to follow", () => consumerSays().find((l) => l.revision === 2));
    const adopted = await until("adoption", async () => {
      const c = (await call(ada, "query", "changes:get", { id: change.id })).change;
      return c.adoption?.adopted.some((x) => x.application === "support-assistant") ? c.adoption : null;
    }, 60_000);
    assert.ok(adopted.fetched.some((x) => x.application === "support-assistant"));
    assert.ok(!adopted.fetched.some((x) => !x.application), `only the registered consumer, not Resolver Control's own reads: ${JSON.stringify(adopted.fetched)}`);
    assert.equal(adopted.functionallyVerified, null);

    // The private key never left the signer; the token never entered Resolver Control's records or logs.
    const pem = (await import("node:fs")).readFileSync(keyFile, "utf8");
    const body = pem.split("\n").filter((l) => l && !l.startsWith("-----")).join("");
    assert.ok(!app.output.includes(body), "the application never sees the private key");
    const signerLog = signer.output.trim().split("\n").filter((l) => l.startsWith("{")).map((l) => JSON.parse(l));
    assert.ok(signerLog.some((l) => l.event === "sign.issued" && l.changeId === change.id && l.jti === `${change.id}.1`));
    assert.ok(!signer.output.includes("eyJ"), "the signer logs ids, never tokens");
    const events = await call(ada, "query", "activity:list", { subjectId: change.id });
    assert.ok(!JSON.stringify(events).includes("eyJ"));
    writeFileSync(join(work, "evidence.json"), JSON.stringify({ change: done, adoption: adopted, history: history.entries, signer: signerLog }, null, 2));
    console.log(`evidence: ${join(work, "evidence.json")}`);
  } finally {
    await stopAll();
  }
});
