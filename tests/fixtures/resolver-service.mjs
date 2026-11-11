// The real Resolver for tests and demos: `@appport/resolver` from npm, installed as the separate
// service it is, in its own directory outside this application's dependency tree (so the app keeps
// exactly one @feltdb/core). The same pattern FeltKit's own Resolver tests use.
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export const RESOLVER_VERSION = "0.3.3";
const dir = fileURLToPath(new URL(`../../.tmp/resolver-service-${RESOLVER_VERSION}`, import.meta.url));
const pkg = join(dir, "node_modules", "@appport", "resolver");

/** Installs Resolver if needed; returns its CLI path and module URL. */
export function resolverService() {
  if (!existsSync(join(pkg, "dist", "cli.js"))) {
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "resolver-service", private: true }));
    execFileSync("npm", ["install", "--no-audit", "--no-fund", "--no-save", `@appport/resolver@${RESOLVER_VERSION}`], { cwd: dir, stdio: ["ignore", "ignore", "pipe"] });
  }
  return { cli: join(pkg, "dist", "cli.js"), module: pathToFileURL(join(pkg, "dist", "index.js")).href, dir };
}

export async function loadResolver() {
  return import(resolverService().module);
}
