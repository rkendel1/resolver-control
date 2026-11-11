/**
 * The `resolver` component: runs the engine on a loop, sooner when Resolver streams a change.
 * Declared in feltkit/app.ts (`components.resolver`): principal `component:resolver` with the
 * `executor` role, credential `resolver-api-key`, network egress. Under `feltkit dev|start` it runs
 * in the application's process; in an AppBoundry artifact, beside the guest (components@1).
 */
import { defineComponent, type ComponentHealth } from "@feltdb/feltkit/server";
import { ResolverEngine, type TickReport } from "./engine.js";

export default defineComponent(async (ctx) => {
  let last: (TickReport & { at: number }) | null = null;
  let running = false;
  let again = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let closed = false;
  let interval = 5_000;

  const engine = new ResolverEngine({
    call: (name, args) => ctx.call(name, args ?? {}),
    apiKey: () => ctx.credential("resolver-api-key"),
    log: ctx.log,
    onRemoteChange: () => schedule(250),
  });

  async function tick() {
    if (running) {
      again = true;
      return;
    }
    running = true;
    try {
      const report = await engine.tick();
      last = { ...report, at: Date.now() };
      const { settings } = await ctx.call<{ settings: { syncIntervalSeconds: number } | null }>("settings:get", {});
      interval = (settings?.syncIntervalSeconds ?? 5) * 1000;
      if (report.state !== "ok") ctx.log.warn(`resolver: ${report.state}${report.detail ? `: ${report.detail}` : ""}`);
    } catch (error) {
      last = { state: "error", detail: (error as Error).message, observed: 0, validated: 0, executed: 0, reconciled: 0, at: Date.now() };
      ctx.log.error(`resolver: tick failed: ${(error as Error).message}`);
    } finally {
      running = false;
      if (again) {
        again = false;
        schedule(0);
      } else schedule(interval);
    }
  }

  function schedule(ms: number) {
    if (closed) return;
    clearTimeout(timer);
    timer = setTimeout(() => void tick(), ms);
  }

  schedule(0);

  return {
    // Status for operators and health checks: what the last pass did. No references, bindings or secrets.
    request(req, res) {
      if (req.method !== "GET" || !req.url?.startsWith("/_resolver-control/status")) {
        res.writeHead(404, { "content-type": "application/json" }).end(JSON.stringify({ error: "not found" }));
        return;
      }
      res.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" }).end(JSON.stringify(last ? { state: last.state, at: last.at, observed: last.observed, validated: last.validated, executed: last.executed, reconciled: last.reconciled } : { state: "starting" }));
    },
    health(): ComponentHealth {
      if (!last) return { state: "starting" };
      if (last.state === "unconfigured") return { state: "unconfigured", detail: last.detail ?? "" };
      if (last.state === "error") return { state: "degraded", detail: last.detail ?? "" };
      return { state: "ready", detail: `${last.observed} references observed` };
    },
    async close() {
      closed = true;
      clearTimeout(timer);
      await engine.close();
    },
  };
});
