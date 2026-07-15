/**
 * @bpmiq/cell-protocol — the control-plane ↔ cell security wire contract
 * (ADR 0002), pinned in ONE place so the two sides can't drift. Zero deps
 * (node:crypto only), so it copies cleanly into the dep-free control-plane image.
 *
 * - Derived per-cell secrets: HMAC(masterKey, "<purpose>:<id>"). The control plane
 *   recomputes any cell's secrets on demand (nothing stored); a cell holding one
 *   tenant's secret can neither mint nor be handed off for another tenant.
 * - Handoff token: the control plane SIGNS a short-lived identity token; the cell
 *   VERIFIES it (byte-identical codec on both sides — this file is that codec).
 */
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

const constantTimeEqual = (a: string, b: string): boolean => {
  const ba = Buffer.from(a);
  const bb = Buffer.from(b);
  return ba.length === bb.length && timingSafeEqual(ba, bb);
};

// ── derived per-cell secrets ────────────────────────────────────────────────
const derive = (masterKey: string, purpose: string, installationId: number): string =>
  createHmac("sha256", masterKey).update(`${purpose}:${installationId}`).digest("base64url");

/** the secret a cell authenticates its /internal/token (mint) calls with */
export const cellSecret = (masterKey: string, installationId: number): string =>
  derive(masterKey, "mint", installationId);

/** the secret the cell verifies control-plane handoff logins with */
export const handoffSecret = (masterKey: string, installationId: number): string =>
  derive(masterKey, "handoff", installationId);

/** the key a cell encrypts persisted installation tokens at rest with — SEPARATE
 * from the mint secret (cellSecret), which is sent as a Bearer on every mint and so
 * has more exposure; a mint secret that leaks in transit must not also unlock the
 * at-rest token store */
export const cellTokenKey = (masterKey: string, installationId: number): string =>
  derive(masterKey, "token", installationId);

/** constant-time check that `presented` is the mint secret for `installationId` */
export function verifyCellSecret(masterKey: string, installationId: number, presented: string): boolean {
  return constantTimeEqual(presented, cellSecret(masterKey, installationId));
}

// ── handoff token ───────────────────────────────────────────────────────────
export interface HandoffIdentity {
  login: string;
  name: string;
  avatarUrl: string | null;
  provider: string;
}

/** verified handoff claims: identity + single-use id (jti) + expiry (epoch seconds) */
export interface HandoffClaims extends HandoffIdentity {
  jti?: string;
  exp: number;
}

/**
 * Sign a handoff token valid for `ttlSeconds` (default 300). Format:
 *   base64url(JSON{login,name,avatarUrl,provider,exp,jti}).hmac_sha256_base64url
 * `jti` lets the cell record redemption so a captured token can't be replayed.
 */
export function signHandoff(user: HandoffIdentity, secret: string, ttlSeconds = 300, nowMs = Date.now()): string {
  const claims = {
    login: user.login,
    name: user.name,
    avatarUrl: user.avatarUrl,
    provider: user.provider,
    exp: Math.floor(nowMs / 1000) + ttlSeconds,
    jti: randomBytes(12).toString("base64url"),
  };
  const payload = Buffer.from(JSON.stringify(claims)).toString("base64url");
  const mac = createHmac("sha256", secret).update(payload).digest("base64url");
  return `${payload}.${mac}`;
}

/**
 * Verify a handoff token's HMAC + expiry, returning its claims or undefined.
 * Pure — SINGLE-USE (jti) enforcement is the cell's job (it needs storage).
 */
export function verifyHandoff(token: string | null, secret: string, nowMs = Date.now()): HandoffClaims | undefined {
  if (!token) return undefined;
  const dot = token.lastIndexOf(".");
  if (dot < 0) return undefined;
  const payload = token.slice(0, dot);
  const mac = token.slice(dot + 1);
  if (!constantTimeEqual(mac, createHmac("sha256", secret).update(payload).digest("base64url"))) return undefined;
  try {
    const claims = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as Partial<HandoffClaims>;
    if (typeof claims.exp !== "number" || claims.exp * 1000 < nowMs) return undefined;
    if (!claims.login) return undefined;
    return {
      login: claims.login,
      name: claims.name ?? claims.login,
      avatarUrl: claims.avatarUrl ?? null,
      provider: claims.provider ?? "github",
      jti: typeof claims.jti === "string" ? claims.jti : undefined,
      exp: claims.exp,
    };
  } catch {
    return undefined;
  }
}
