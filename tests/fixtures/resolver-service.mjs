// The real Resolver for tests and demos: `@appport/resolver` from npm, installed as the separate
// service it is, in its own directory outside this application's dependency tree (so the app keeps
// exactly one @feltdb/core). The same pattern FeltKit's own Resolver tests use.
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export const RESOLVER_VERSION = "0.3.3";
/**
 * RESOLVER_SERVICE_FROM: a directory holding packed Resolver tarballs (`npm pack` of core, client and server),
 * to test a Resolver build that is not published yet. Its packages resolve to each other through overrides.
 */
const FROM = process.env.RESOLVER_SERVICE_FROM;
const dir = FROM
  ? fileURLToPath(new URL(`../../.tmp/resolver-service-local-${createHash("sha256").update(readdirSync(FROM).sort().map((f) => f + statSync(join(FROM, f)).mtimeMs).join()).digest("hex").slice(0, 12)}`, import.meta.url))
  : fileURLToPath(new URL(`../../.tmp/resolver-service-${RESOLVER_VERSION}`, import.meta.url));
const pkg = join(dir, "node_modules", "@appport", "resolver");

/** Installs Resolver if needed; returns its CLI path and module URL. */
export function resolverService() {
  if (!existsSync(join(pkg, "dist", "cli.js"))) {
    mkdirSync(dir, { recursive: true });
    if (FROM) {
      const tgz = (name) => join(FROM, readdirSync(FROM).find((f) => new RegExp(`^appport-${name}-\\d`).test(f)));
      writeFileSync(join(dir, "package.json"), JSON.stringify({
        name: "resolver-service",
        private: true,
        dependencies: { "@appport/resolver": `file:${tgz("resolver")}` },
        overrides: { "@appport/resolver-client": `file:${tgz("resolver-client")}`, "@appport/resolver-core": `file:${tgz("resolver-core")}` },
      }));
      execFileSync("npm", ["install", "--no-audit", "--no-fund"], { cwd: dir, stdio: ["ignore", "ignore", "pipe"] });
    } else {
      writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "resolver-service", private: true }));
      execFileSync("npm", ["install", "--no-audit", "--no-fund", "--no-save", `@appport/resolver@${RESOLVER_VERSION}`], { cwd: dir, stdio: ["ignore", "ignore", "pipe"] });
    }
  }
  return { cli: join(pkg, "dist", "cli.js"), module: pathToFileURL(join(pkg, "dist", "index.js")).href, dir };
}

export async function loadResolver() {
  return import(resolverService().module);
}
