/**
 * Agents and discovery: what an agent may do through the application's capabilities, what it may
 * not, and the deterministic scanner feeding discovery.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createTestApp } from "@feltdb/feltkit/testing";
import { api } from "../feltkit/_generated/api.js";
import { engineFor, seedResolver, settle, startResolver } from "./helpers.js";

test("an agent inspects, declares, proposes and submits findings; it never approves, executes, or changes policy", async () => {
  const resolver = await startResolver();
  const t = await createTestApp();
  const engine = engineFor(t, resolver);
  try {
    await seedResolver(resolver.admin);
    await t.as("ada").mutation(api.settings.set, { resolverUrl: resolver.url, namespaces: ["prod", "staging"] });
    await t.as("ada").mutation(api.demo.seed, {});
    await settle(engine, 1);
    const agent = t.as("ops-agent");

    const inventory = await agent.query(api.catalog.inventory, {});
    assert.ok(inventory.length >= 4);
    const detail = await agent.query(api.catalog.detail, { ref: "ref://prod/search" });
    assert.equal(detail.observation!.revision, 1);
    await agent.mutation(api.catalog.declareConsumer, { ref: "ref://prod/search", application: "recommendations", usage: "related products" });
    const change = await agent.mutation(api.changes.proposeRetarget, { ref: "ref://prod/search", basedOnRevision: 1, binding: { value: { url: "https://search-b.example.com" } }, reason: "Agent: provider B is cheaper at equal latency" });
    assert.equal(change.proposedByType, "agent");
    assert.equal(change.impact.declaredConsumers.length, 2);
    await settle(engine, 1);

    const refused = (e: { code: string }) => e.code === "FORBIDDEN";
    await assert.rejects(agent.mutation(api.changes.approve, { id: change.id }), refused);
    await assert.rejects(agent.mutation(api.policies.freeze, { environment: "prod", frozen: false }), refused);
    await assert.rejects(agent.mutation(api.changes.settle, { id: change.id, attempt: 1, outcome: "verified" }), refused);
    await assert.rejects(agent.mutation(api.observations.upsert, { items: [] }), refused);
    await assert.rejects(agent.mutation(api.settings.set, { resolverUrl: "http://evil.example", namespaces: ["prod"] }), refused);
    // Executor-only work is closed to people too.
    await assert.rejects(t.as("ada").mutation(api.changes.claim, { id: change.id }), refused);
    assert.equal((await t.as("ada").query(api.changes.get, { id: change.id })).change.status, "ready", "the agent's proposal waits for a person");
    assert.equal((await resolver.admin.resolve("ref://prod/search")).revision, 1, "nothing changed in Resolver");
  } finally {
    await engine.close();
    await t.close();
    await resolver.close();
  }
});

test("the discovery scanner finds embedded decisions, redacts secrets, skips catalogs, and its findings are deduplicated candidates", async () => {
  const repo = mkdtempSync(join(tmpdir(), "rc-scan-"));
  mkdirSync(join(repo, "src"));
  mkdirSync(join(repo, "tests"));
  writeFileSync(join(repo, "src/support.ts"), [
    'import OpenAI from "openai";',
    'const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });',
    'export const reply = (q: string) => client.chat.completions.create({ model: "gpt-4o", messages: [{ role: "user", content: q }] });',
    'const leaked = "sk-proj-abcdefghijklmnopqrstuvwxyz0123456789";',
    'const stripe = "https://api.stripe.com/v1/charges";',
    'const search = process.env.SEARCH_URL;',
    '// "claude-sonnet-5-5" in a comment is not a decision',
  ].join("\n"));
  writeFileSync(join(repo, "src/models.ts"), ['"gpt-4o"', '"gpt-4o-mini"', '"claude-sonnet-5-5"', '"claude-haiku-4-5"', '"gemini-2.5-pro"'].map((m) => `export const m${m.length} = ${m};`).join("\n"));
  writeFileSync(join(repo, "tests/support.test.ts"), 'const model = "gpt-4o";');

  const out = JSON.parse(execFileSync(process.execPath, ["scripts/discover.mjs", repo, "--name", "support-app", "--json"], { encoding: "utf8" }));
  const by = (pattern: string) => out.findings.filter((f: { pattern: string }) => f.pattern === pattern);
  assert.equal(by("model-id").length, 1, JSON.stringify(out.findings, null, 1));
  assert.equal(by("model-id")[0].location, "src/support.ts:3");
  assert.equal(by("model-id")[0].suggestedRef, "ref://prod/ai/gpt");
  assert.equal(by("provider-host:api.stripe.com")[0].category, "payments");
  assert.equal(by("env-endpoint")[0].suggestedRef, "ref://prod/search");
  assert.equal(by("env-credential")[0].suggestedKind, "secret");
  assert.deepEqual(out.summary.skippedAsCatalogs, ["src/models.ts"]);
  assert.ok(!JSON.stringify(out).includes("abcdefghijklmnopqrstuvwxyz0123456789"), "key material is redacted");
  assert.ok(!out.findings.some((f: { location: string }) => f.location.startsWith("tests/")), "tests are not production decisions");

  const t = await createTestApp();
  try {
    const agent = t.as("ops-agent");
    const first = await agent.mutation(api.discovery.submit, { items: out.findings });
    assert.equal(first.added, out.findings.length);
    const again = await agent.mutation(api.discovery.submit, { items: out.findings });
    assert.equal(again.added, 0, "fingerprints deduplicate a rescan");
    const open = await t.as("grace").query(api.discovery.list, { status: "open" });
    assert.equal(open[0]!.source, "agent");
    const adopted = await t.as("grace").mutation(api.discovery.resolve, { id: open[0]!.id, status: "adopted", ref: "ref://prod/ai/support-chat", note: "Model choice moves to Resolver" });
    assert.equal(adopted.resolution!.ref, "ref://prod/ai/support-chat");
    await assert.rejects(t.as("katherine").mutation(api.discovery.resolve, { id: open[1]!.id, status: "dismissed" }), (e: { code: string }) => e.code === "FORBIDDEN");
  } finally {
    await t.close();
  }
});
