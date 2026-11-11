#!/usr/bin/env node
// A consuming application, as small as it gets: it names what it needs (a model, a search endpoint)
// and resolves them at run time through Resolver's client. It is started once and never redeployed.
// Each line it prints says what it would use right now and at which revision.
//
//   RESOLVER_URL=http://127.0.0.1:4300 RESOLVER_API_KEY=<a key with read on ref://prod/*, reveal on ref://prod/llm/*> node examples/consumer-app.mjs
//
// It prints the credential's reference and revision, never the key.
import { ResolverClient } from "@appport/resolver-client";

const url = process.env.RESOLVER_URL;
const apiKey = process.env.RESOLVER_API_KEY;
const refs = (process.env.CONSUMER_REFS ?? "ref://prod/ai/default,ref://prod/search").split(",");
const every = Number(process.env.CONSUMER_INTERVAL_MS ?? 1000);
if (!url || !apiKey) {
  console.error("Set RESOLVER_URL and RESOLVER_API_KEY.");
  process.exit(2);
}

const resolver = await ResolverClient.connect({ url, apiKey, onWarning: (w) => console.error(JSON.stringify({ warning: w.kind, ref: w.ref })) });
const startedAt = new Date().toISOString();
let stop = false;
process.on("SIGTERM", () => (stop = true));
process.on("SIGINT", () => (stop = true));

while (!stop) {
  for (const ref of refs) {
    try {
      const resolved = await resolver.resolve(ref);
      if (resolved.kind === "model") {
        const model = await resolver.model(ref);
        console.log(JSON.stringify({ pid: process.pid, startedAt, ref, revision: model.revision, uses: `${model.provider}/${model.model}`, credential: model.credential ?? null, credentialRevision: model.credentialRevision ?? null, hasKey: Boolean(model.apiKey) }));
      } else {
        console.log(JSON.stringify({ pid: process.pid, startedAt, ref, revision: resolved.revision, strategy: resolved.strategy, uses: resolved.selected.value }));
      }
    } catch (error) {
      console.log(JSON.stringify({ pid: process.pid, ref, error: error.code ?? "ERROR", message: error.message }));
    }
  }
  await new Promise((r) => setTimeout(r, every));
}
await resolver.close();
