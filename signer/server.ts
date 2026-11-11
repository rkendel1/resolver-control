/**
 * The approval signer as a process: `node --import tsx signer/server.ts` (or `npm run signer`).
 *
 *   POST /sign   { changeId, attempt }      Bearer <client token>  → 200 { authorization, jti, expiresAt }
 *                                                                   → 403 { reason, message }   refused
 *                                                                   → 503 { reason, message }   Resolver Control unreachable (retry)
 *   GET  /key    the public key and kid, to register with Resolver (`resolver signing-key add`)
 *   GET  /ready
 *
 * Configuration (environment; secrets from files):
 *   SIGNER_PRIVATE_KEY_FILE   Ed25519 private key, PKCS#8 PEM (`npm run signer -- --generate <file>` makes one)
 *   SIGNER_KID, SIGNER_ISSUER (resolver-control), SIGNER_TENANT, SIGNER_SCOPE (comma-separated patterns)
 *   SIGNER_EXECUTOR (component:resolver), SIGNER_MIN_APPROVALS (1), SIGNER_VALIDITY_SECONDS (300)
 *   SIGNER_CLIENT_TOKEN_FILE  the token the component presents (its `approval-signer-token` credential)
 *   RC_URL, RC_TOKEN_FILE     Resolver Control and the signer's own session there (role `signer`: read only)
 *   PORT (8790), HOST (127.0.0.1)
 */
import { createPrivateKey, createPublicKey, timingSafeEqual, createHash, type KeyObject } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { fileURLToPath } from "node:url";
import { generateSigningKey } from "@appport/resolver-client/authorization";
import { createSigner, type AuditEvent, type ChangeView, type Reader, type SignerConfig } from "./core.js";

export class SourceUnavailable extends Error {}

/** Reads Resolver Control over its HTTP API as the signer's own session. */
export function httpReader(url: string, token: string, timeoutMs = 5000): Reader {
  const call = async <T>(name: string, args: object): Promise<T> => {
    let response: Response;
    try {
      response = await fetch(`${url.replace(/\/$/, "")}/api/query/${name}`, { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: JSON.stringify({ args }), signal: AbortSignal.timeout(timeoutMs) });
    } catch (error) {
      throw new SourceUnavailable(`Resolver Control did not answer: ${(error as Error).message}`);
    }
    const body = (await response.json().catch(() => null)) as { ok: boolean; value?: T; error?: { code?: string; message?: string } } | null;
    if (!body) throw new SourceUnavailable(`Resolver Control answered ${response.status} without a body.`);
    if (!body.ok) {
      if (body.error?.code === "NOT_FOUND") return null as T;
      if (response.status >= 500) throw new SourceUnavailable(`Resolver Control: ${body.error?.message ?? response.status}`);
      throw new Error(`Resolver Control refused the signer's read (${body.error?.code}): ${body.error?.message}`);
    }
    return body.value as T;
  };
  return {
    change: (id) => call<ChangeView | null>("changes:get", { id }),
    events: (id) => call<AuditEvent[]>("activity:list", { subjectId: id, limit: 500 }),
  };
}

export function publicKeyOf(privateKey: KeyObject | string): string {
  const key = typeof privateKey === "string" ? createPrivateKey(privateKey) : privateKey;
  // SPKI DER for Ed25519 is a 12-byte prefix followed by the raw 32-byte key: Resolver registers the raw key.
  return createPublicKey(key).export({ format: "der", type: "spki" }).subarray(12).toString("base64url");
}

const digest = (s: string) => createHash("sha256").update(s).digest();
const sameToken = (a: string, b: string) => timingSafeEqual(digest(a), digest(b));

export interface SignerServerOptions extends SignerConfig {
  clientToken: string;
  port?: number;
  host?: string;
  log?: (entry: Record<string, unknown>) => void;
}

export async function startSigner(options: SignerServerOptions): Promise<{ url: string; close(): Promise<void> }> {
  const signer = createSigner(options);
  const log = options.log ?? ((entry) => process.stdout.write(`${JSON.stringify({ at: new Date().toISOString(), ...entry })}\n`));
  const send = (res: ServerResponse, status: number, body: unknown) => res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" }).end(JSON.stringify(body));

  async function handle(req: IncomingMessage, res: ServerResponse) {
    if (req.method === "GET" && req.url === "/ready") return send(res, 200, { ready: true });
    if (req.method === "GET" && req.url === "/key") return send(res, 200, { issuer: options.issuer, kid: options.kid, publicKey: publicKeyOf(options.privateKey) });
    if (req.method !== "POST" || req.url !== "/sign") return send(res, 404, { reason: "signer.not-found", message: "POST /sign" });
    const presented = (req.headers.authorization ?? "").replace(/^Bearer\s+/i, "");
    if (!presented || !sameToken(presented, options.clientToken)) {
      log({ event: "sign.unauthenticated" });
      return send(res, 401, { reason: "signer.unauthenticated", message: "A valid client token is required." });
    }
    let body: { changeId?: unknown; attempt?: unknown };
    try {
      const chunks: Buffer[] = [];
      let size = 0;
      for await (const chunk of req) {
        size += (chunk as Buffer).length;
        if (size > 4096) return send(res, 413, { reason: "signer.invalid-request", message: "Request too large." });
        chunks.push(chunk as Buffer);
      }
      body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    } catch {
      return send(res, 400, { reason: "signer.invalid-request", message: "JSON body { changeId, attempt } expected." });
    }
    try {
      const result = await signer.sign({ changeId: body.changeId as string, attempt: body.attempt as number });
      if (!result.ok) {
        log({ event: "sign.refused", changeId: body.changeId, attempt: body.attempt, reason: result.reason, message: result.message });
        return send(res, 403, { reason: result.reason, message: result.message });
      }
      log({ event: "sign.issued", changeId: body.changeId, attempt: body.attempt, jti: result.jti, ref: result.ref, op: result.op, expectedRevision: result.expectedRevision, expiresAt: result.expiresAt });
      return send(res, 200, { authorization: result.authorization, jti: result.jti, expiresAt: result.expiresAt });
    } catch (error) {
      const unavailable = error instanceof SourceUnavailable;
      log({ event: "sign.error", changeId: body.changeId, attempt: body.attempt, message: (error as Error).message });
      return send(res, unavailable ? 503 : 500, { reason: unavailable ? "signer.source-unavailable" : "signer.error", message: (error as Error).message });
    }
  }

  const server = createServer((req, res) => void handle(req, res).catch((error) => send(res, 500, { reason: "signer.error", message: (error as Error).message })));
  await new Promise<void>((resolve) => server.listen(options.port ?? 0, options.host ?? "127.0.0.1", resolve));
  const address = server.address() as { port: number };
  return {
    url: `http://${options.host ?? "127.0.0.1"}:${address.port}`,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
}
const secretFile = (name: string) => readFileSync(required(name), "utf8").trim();

async function main() {
  const args = process.argv.slice(2);
  if (args[0] === "--generate") {
    const file = args[1];
    if (!file) throw new Error("--generate <private key file>");
    const { publicKey, privateKeyPem } = generateSigningKey();
    writeFileSync(file, privateKeyPem, { mode: 0o600, flag: "wx" });
    process.stdout.write(`${JSON.stringify({ privateKeyFile: file, publicKey })}\n`);
    return;
  }
  const privateKey = createPrivateKey(secretFile("SIGNER_PRIVATE_KEY_FILE"));
  const signer = await startSigner({
    privateKey,
    kid: required("SIGNER_KID"),
    issuer: process.env.SIGNER_ISSUER ?? "resolver-control",
    tenant: required("SIGNER_TENANT"),
    scope: required("SIGNER_SCOPE").split(",").map((s) => s.trim()).filter(Boolean),
    executor: process.env.SIGNER_EXECUTOR ?? "component:resolver",
    minApprovals: Number(process.env.SIGNER_MIN_APPROVALS ?? 1),
    validitySeconds: Number(process.env.SIGNER_VALIDITY_SECONDS ?? 300),
    maxClaimAgeMs: 60_000,
    clientToken: secretFile("SIGNER_CLIENT_TOKEN_FILE"),
    reader: httpReader(required("RC_URL"), secretFile("RC_TOKEN_FILE")),
    port: Number(process.env.PORT ?? 8790),
    host: process.env.HOST ?? "127.0.0.1",
  });
  process.stdout.write(`${JSON.stringify({ event: "ready", url: signer.url })}\n`);
  const stop = () => void signer.close().then(() => process.exit(0));
  process.on("SIGTERM", stop);
  process.on("SIGINT", stop);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch((error) => {
    process.stderr.write(`${(error as Error).message}\n`);
    process.exit(1);
  });
}
