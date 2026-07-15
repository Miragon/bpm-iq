/**
 * Shared node:http primitives for the bpmiq backends (@bpmiq/http-kit).
 *
 * Extracted after the send/redirect/rawBody/OAuth-state plumbing had been
 * copy-pasted between live-host and control-plane and DRIFTED (the control
 * plane's rawBody lost its return-after-reject; the two apps' state secrets
 * had different lifecycles). One canonical implementation, unit-tested,
 * typechecked against both apps — the same anti-drift role cell-protocol and
 * github-app already play.
 *
 * Deliberately zero third-party deps (node builtins only), so the package
 * copies cleanly into the dependency-free control-plane image (COPY + symlink,
 * no pnpm install — see apps/control-plane/Dockerfile).
 *
 * NOT here on purpose: session/cookie POLICY (the two apps have different
 * security models — stateless HMAC cookies vs SQLite sessions), webhook
 * verification (different secrets/flows), and any router abstraction. Only
 * primitives live here.
 */
import { createHmac, timingSafeEqual } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";

// typed errors + the error→HTTP mapper (both backends' catch-alls use it)
export { AppError, errorBody } from "./errors.ts";

// ── responses ────────────────────────────────────────────────────────────────

/** JSON/text response. Dynamic + often session-bound → `cache-control: no-store`
 * (static assets are served elsewhere with their own cache headers). String
 * bodies are plain error text — don't mislabel them as HTML. */
export function send(
  res: ServerResponse,
  status: number,
  body: unknown,
  headers: Record<string, string | string[]> = {},
): void {
  const text = typeof body === "string" ? body : JSON.stringify(body);
  res.writeHead(status, {
    "content-type": typeof body === "string" ? "text/plain; charset=utf-8" : "application/json",
    "cache-control": "no-store",
    ...headers,
  });
  res.end(text);
}

export function redirect(res: ServerResponse, location: string, headers: Record<string, string | string[]> = {}): void {
  res.writeHead(302, { location, ...headers });
  res.end();
}

/** baseline security headers for EVERY response. Set via setHeader (not
 * writeHead) so route-level writeHead calls merge on top. A full script-src
 * CSP is a deliberate non-goal here: the control-plane chooser POSTs handoff
 * forms to per-tenant cell origins (form-action would break them). */
export function securityHeaders(res: ServerResponse, opts: { secure: boolean }): void {
  res.setHeader("x-content-type-options", "nosniff");
  res.setHeader("referrer-policy", "no-referrer");
  res.setHeader("content-security-policy", "frame-ancestors 'none'");
  if (opts.secure) res.setHeader("strict-transport-security", "max-age=31536000; includeSubDomains");
}

// ── requests ─────────────────────────────────────────────────────────────────

/** buffer a request body, hard-capped (DoS guard). Rejects AND stops buffering
 * past the cap — the missing `return` after reject is exactly the drift bug
 * this package exists to prevent. */
export function readBody(req: IncomingMessage, opts: { maxBytes?: number } = {}): Promise<Buffer> {
  const maxBytes = opts.maxBytes ?? 1_000_000;
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (c: Buffer) => {
      size += c.length;
      if (size > maxBytes) {
        req.destroy();
        reject(new Error("body too large"));
        return; // stop buffering — already-received chunks must not pile up
      }
      chunks.push(c);
    });
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

/** read one cookie value out of a request `Cookie` header (empty → undefined) */
export function readCookie(header: string | undefined, name: string): string | undefined {
  return (
    header
      ?.split(";")
      .map((x) => x.trim())
      .find((x) => x.startsWith(`${name}=`))
      ?.slice(name.length + 1) || undefined
  );
}

// ── crypto primitives (constant-time; the 6 hand-rolled copies collapse here) ─

/** constant-time string equality — length-safe, no early-out on the first mismatch */
export function timingSafeStr(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && timingSafeEqual(ab, bb);
}

/** constant-time check that the request's Bearer token equals `secret` */
export function bearerAuth(req: IncomingMessage, secret: string): boolean {
  return timingSafeStr(req.headers.authorization?.replace(/^Bearer /, "") ?? "", secret);
}

/** base64url HMAC-SHA256 of `data` under `secret` */
export function hmac(secret: Buffer | string, data: string): string {
  return createHmac("sha256", secret).update(data).digest("base64url");
}

/** sign `data` → "<data>.<mac>"; `data` must be dot-free at its END (the split
 * back out happens at the LAST dot, so inner dots in `data` are fine) */
export function tag(secret: Buffer | string, data: string): string {
  return `${data}.${hmac(secret, data)}`;
}

/** verify a "<data>.<mac>" token, returning `data` iff the mac matches */
export function untag(secret: Buffer | string, token: string): string | undefined {
  const dot = token.lastIndexOf(".");
  if (dot < 0) return undefined;
  const data = token.slice(0, dot);
  return timingSafeStr(token.slice(dot + 1), hmac(secret, data)) ? data : undefined;
}
