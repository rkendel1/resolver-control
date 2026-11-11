#!/usr/bin/env node
/**
 * Discovery scanner: finds operational decisions embedded in a codebase that could be explicit
 * runtime references (a hardcoded model id, a provider's API host, a service URL or key read from
 * the environment). Deterministic: patterns, not a model. Every finding carries its file, line,
 * the pattern that matched and an excerpt with anything secret-looking redacted.
 *
 *   node scripts/discover.mjs <repository-dir> [--name <repo name>] [--env prod] [--json]
 *   node scripts/discover.mjs <dir> --submit http://localhost:3000   (RC_TOKEN=<session token with discovery.write>)
 *
 * What it cannot know: whether two implementations are compatible, whether a value is really
 * operational, or what the consumer would need to change. A finding is a candidate for a person to
 * judge, never a dependency.
 */
import { createHash } from "node:crypto";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { basename, extname, join, relative, resolve } from "node:path";

const args = process.argv.slice(2);
const VALUED = new Set(["--name", "--submit", "--env"]);
const positional = args.filter((a, i) => !a.startsWith("--") && !VALUED.has(args[i - 1]));
const root = resolve(positional[0] ?? ".");
const flag = (name) => (args.includes(name) ? args[args.indexOf(name) + 1] : undefined);
const repository = flag("--name") ?? basename(root);
const environment = flag("--env") ?? "prod";
const submit = flag("--submit");

const CODE = new Set([".ts", ".tsx", ".js", ".mjs", ".cjs", ".jsx", ".py", ".go", ".rb", ".java", ".kt", ".cs", ".php", ".rs", ".yaml", ".yml", ".toml", ".env.example"]);
const SKIP_DIRS = new Set(["node_modules", ".git", "dist", "build", "out", "vendor", ".next", "coverage", "target", "__pycache__", ".venv", "venv", ".tmp", ".feltkit"]);
const TEST_PATH = /(^|\/)(tests?|__tests__|spec|fixtures|e2e|examples?|docs?)(\/|$)|\.(test|spec)\.[a-z]+$/i;

const slug = (s) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 40) || "x";

/** Each rule: what matched, why it matters, and the reference it suggests. */
const RULES = [
  {
    id: "model-id",
    category: "ai",
    kind: "model",
    // A model identifier in a string literal.
    regex: /["'`]((?:gpt-[0-9][a-z0-9.-]*|o[134](?:-mini|-pro)?|claude-[a-z0-9.-]+|gemini-[0-9][a-z0-9.-]*|llama-?[0-9][a-z0-9.:-]*|mistral-[a-z0-9.-]+|command-r[a-z0-9+-]*))["'`]/gi,
    ref: (m) => `ai/${slug(m[1].split(/[-.:]/)[0])}`,
    why: (m) => `The model "${m[1]}" is chosen in code: changing it needs a code change and a deployment. A model reference lets operators switch it (and steer a canary) at run time.`,
  },
  ...[
    ["api.openai.com", "ai", "model", "llm/openai"],
    ["api.anthropic.com", "ai", "model", "llm/anthropic"],
    ["generativelanguage.googleapis.com", "ai", "model", "llm/google"],
    ["api.stripe.com", "payments", "endpoint", "payments"],
    ["api.braintreegateway.com", "payments", "endpoint", "payments"],
    ["api.sendgrid.com", "email", "endpoint", "email"],
    ["api.mailgun.net", "email", "endpoint", "email"],
    ["api.postmarkapp.com", "email", "endpoint", "email"],
    ["api.resend.com", "email", "endpoint", "email"],
    ["api.twilio.com", "communications", "endpoint", "sms"],
    ["algolia.net", "search", "endpoint", "search"],
    ["typesense", "search", "endpoint", "search"],
    ["meilisearch", "search", "endpoint", "search"],
    ["auth0.com", "identity", "endpoint", "identity"],
    ["okta.com", "identity", "endpoint", "identity"],
    ["login.microsoftonline.com", "identity", "endpoint", "identity"],
    ["s3.amazonaws.com", "storage", "endpoint", "storage"],
    ["storage.googleapis.com", "storage", "endpoint", "storage"],
    ["blob.core.windows.net", "storage", "endpoint", "storage"],
    ["api.segment.io", "analytics", "endpoint", "analytics/events"],
    ["api.mixpanel.com", "analytics", "endpoint", "analytics/events"],
    ["posthog.com", "analytics", "endpoint", "analytics/events"],
    ["textract", "processing", "endpoint", "processing/documents"],
    ["documentai.googleapis.com", "processing", "endpoint", "processing/documents"],
  ].map(([host, category, kind, path]) => ({
    id: `provider-host:${host}`,
    category,
    kind,
    regex: new RegExp(`["'\`][^"'\`\\s]*${host.replace(/\./g, "\\.")}[^"'\`\\s]*["'\`]`, "gi"),
    ref: () => path,
    why: () => `A ${category} provider (${host}) is wired into code. Behind a ${kind} reference, a compatible provider can be selected without a deployment; a different API needs an adapter first.`,
  })),
  {
    id: "env-endpoint",
    category: "integrations",
    kind: "endpoint",
    // An endpoint read from the environment: changing it means redeploying with new configuration.
    regex: /(?:process\.env\.|os\.environ(?:\.get)?\(\s*["']|getenv\(\s*["']|ENV\[["']|env::var\(\s*")([A-Z][A-Z0-9_]*(?:_URL|_ENDPOINT|_HOST|_BASE_URL|_API_BASE))\b/g,
    ref: (m) => slug(m[1].replace(/_(URL|ENDPOINT|HOST|BASE_URL|API_BASE)$/, "").toLowerCase()),
    why: (m) => `${m[1]} is deployment configuration: changing where it points needs new environment variables and a restart or redeploy. An endpoint reference changes at run time, with history and rollback.`,
  },
  {
    id: "env-credential",
    category: "credentials",
    kind: "secret",
    regex: /(?:process\.env\.|os\.environ(?:\.get)?\(\s*["']|getenv\(\s*["']|ENV\[["']|env::var\(\s*")([A-Z][A-Z0-9_]*(?:_API_KEY|_TOKEN|_SECRET|_SECRET_KEY))\b/g,
    ref: (m) => `keys/${slug(m[1].replace(/_(API_KEY|TOKEN|SECRET|SECRET_KEY)$/, "").toLowerCase())}`,
    why: (m) => `${m[1]} is a credential in the process environment: rotating it needs a redeploy or restart. A secret reference rotates in Resolver, with a reveal log, and running consumers pick it up.`,
  },
];

/** Excerpts never carry secrets: anything that looks like key material is replaced. */
function redact(text) {
  return text
    .replace(/\b(sk|pk|rk|xox[abp]|ghp|gho|AKIA)[-_A-Za-z0-9]{8,}/g, "[redacted]")
    .replace(/[A-Za-z0-9+/_=-]{32,}/g, "[redacted]")
    .trim()
    .slice(0, 200);
}

function* files(dir) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name.startsWith(".") && entry.name !== ".env.example") continue;
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (!SKIP_DIRS.has(entry.name)) yield* files(path);
    } else if (CODE.has(extname(entry.name)) || entry.name === ".env.example") {
      if (statSync(path).size < 1_000_000) yield path;
    }
  }
}

const findings = [];
const seen = new Set();
let scanned = 0;
for (const path of files(root)) {
  const rel = relative(root, path).split("\\").join("/");
  if (TEST_PATH.test(rel)) continue;
  scanned += 1;
  const lines = readFileSync(path, "utf8").split("\n");
  lines.forEach((line, index) => {
    if (/^\s*(\/\/|#|\*|\/\*)/.test(line)) return; // comments are not decisions
    for (const rule of RULES) {
      for (const match of line.matchAll(rule.regex)) {
        const literal = match[1] ?? match[0];
        const key = `${rel}\0${rule.id}\0${literal}`;
        if (seen.has(key)) continue;
        seen.add(key);
        findings.push({
          repository,
          location: `${rel}:${index + 1}`,
          category: rule.category,
          pattern: rule.id.slice(0, 80),
          excerpt: redact(line),
          suggestedRef: `ref://${environment}/${rule.ref(match)}`,
          suggestedKind: rule.kind,
          rationale: rule.why(match),
          fingerprint: createHash("sha256").update(`${repository}\0${key}`).digest("hex").slice(0, 40),
        });
      }
    }
  });
}

// A file naming many different models is a catalog of options (e.g. a provider list), not a choice:
// its model and provider findings are dropped, and the file is reported so a person can check.
const CATALOG_THRESHOLD = 4;
const modelsPerFile = new Map();
for (const f of findings) if (f.pattern === "model-id") {
  const file = f.location.replace(/:\d+$/, "");
  modelsPerFile.set(file, (modelsPerFile.get(file) ?? 0) + 1);
}
const catalogs = [...modelsPerFile].filter(([, n]) => n >= CATALOG_THRESHOLD).map(([file]) => file);
for (let i = findings.length - 1; i >= 0; i--) {
  const f = findings[i];
  if (catalogs.includes(f.location.replace(/:\d+$/, "")) && (f.pattern === "model-id" || f.pattern.startsWith("provider-host:"))) findings.splice(i, 1);
}

const summary = { repository, scanned, ...(catalogs.length ? { skippedAsCatalogs: catalogs } : {}), findings: findings.length, byCategory: findings.reduce((acc, f) => ((acc[f.category] = (acc[f.category] ?? 0) + 1), acc), {}) };

if (submit) {
  const token = process.env.RC_TOKEN;
  if (!token) {
    console.error("Set RC_TOKEN to a session token whose roles grant discovery.write (feltkit session create --role engineer).");
    process.exit(2);
  }
  let added = 0;
  for (let i = 0; i < findings.length; i += 100) {
    const response = await fetch(`${submit.replace(/\/$/, "")}/api/mutation/discovery:submit`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ args: { items: findings.slice(i, i + 100) } }),
    });
    const body = await response.json();
    if (!body.ok) {
      console.error(`Refused: ${body.error?.code} ${body.error?.message}`);
      process.exit(1);
    }
    added += body.value.added;
  }
  console.log(JSON.stringify({ ...summary, submitted: findings.length, added }, null, 2));
} else if (args.includes("--json")) {
  console.log(JSON.stringify({ summary, findings }, null, 2));
} else {
  console.log(JSON.stringify(summary, null, 2));
  for (const f of findings.slice(0, 40)) console.log(`${f.category.padEnd(14)} ${f.location.padEnd(50)} ${f.suggestedRef}  (${f.pattern})`);
  if (findings.length > 40) console.log(`… ${findings.length - 40} more (--json for all)`);
}
