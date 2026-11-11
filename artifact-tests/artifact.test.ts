/**
 * The compiled AppBoundry artifact (`resolver-control.app`): the WebAssembly guest, run in
 * FeltKit's reference AppBoundry host, driven by the same resolver engine the artifact's
 * `components@1` section carries, against the real Resolver. Proves the governance logic behaves
 * the same compiled to WebAssembly with no network, and that the component contract holds.
 *
 * Run: npm run test:artifact   (builds the artifact first)
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { ResolverClient } from "@appport/resolver-client";
import { createArtifactTestApp } from "@feltdb/feltkit/testing";
import { api } from "../feltkit/_generated/api.js";
import { engineFor, seedResolver, settle, startResolver } from "../tests/helpers.js";

const ARTIFACT = "resolver-control.app";

test("the artifact: no network in the guest, the Resolver key only in the component, the full change lifecycle in WebAssembly", async () => {
  assert.ok(existsSync(ARTIFACT), "build it first: npm run build:app");
  const manifest = JSON.parse(readFileSync(`${ARTIFACT}/manifest.json`, "utf8"));
  assert.equal(manifest.permissions.network, "none");
  assert.equal(manifest.permissions.filesystem, "none");
  const component = manifest.components.find((c: { name: string }) => c.name === "resolver");
  assert.deepEqual(component.credentials, ["resolver-api-key"]);
  assert.equal(component.network, "egress");
  assert.deepEqual(component.principal, { id: "component:resolver", roles: ["executor"] });
  assert.ok(!JSON.stringify(manifest).includes("sk-"), "no credential material in the manifest");

  const resolver = await startResolver();
  const t = await createArtifactTestApp(ARTIFACT);
  const consumer = await ResolverClient.connect({ url: resolver.url, apiKey: resolver.consumerKey });
  const engine = engineFor(t, resolver);
  try {
    await seedResolver(resolver.admin);
    await t.as("ada").mutation(api.settings.set, { resolverUrl: resolver.url, namespaces: ["prod", "staging"] });
    await t.as("ada").mutation(api.demo.seed, {});
    await settle(engine, 1);
    const row = (await t.as("ada").query(api.catalog.inventory, {})).find((r) => r.ref === "ref://prod/ai/default")!;
    assert.equal(row.governance, "governed");

    const change = await t.as("grace").mutation(api.changes.proposeRetarget, { ref: "ref://prod/ai/default", basedOnRevision: 1, binding: { value: { provider: "anthropic", model: "claude-sonnet-5-5", credential: "ref://prod/llm/primary-key" } }, reason: "Artifact run: switch default chat model" });
    await settle(engine, 1);
    await assert.rejects(t.as("barbara").mutation(api.changes.approve, { id: change.id }), /protected/);
    await t.as("linus").mutation(api.changes.approve, { id: change.id });
    await settle(engine, 1);
    const done = await t.as("ada").query(api.changes.get, { id: change.id });
    assert.equal(done.change.status, "verified", JSON.stringify(done.change.execution));
    assert.equal(done.change.verification!.correlated, true);

    let model = await consumer.model("ref://prod/ai/default");
    const deadline = Date.now() + 5000;
    while (model.revision !== 2 && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 50));
      model = await consumer.model("ref://prod/ai/default");
    }
    assert.equal(model.model, "claude-sonnet-5-5");
    const trail = (await t.as("ada").query(api.activity.list, { subjectId: change.id })).map((e) => e.type);
    assert.ok(trail.includes("change.verified"));
  } finally {
    await engine.close();
    await consumer.close();
    await t.close();
    await resolver.close();
  }
});
