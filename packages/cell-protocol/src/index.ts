/**
 * @bpmiq/cell-protocol — the control-plane ↔ cell security wire contract
 * (ADR 0002), pinned in ONE place so the two sides can't drift. Zero deps
 * (node:crypto only), so it copies cleanly into the dep-free control-plane image.
 *
 * - Derived per-cell secrets: HMAC(masterKey, "<purpose>:<id>"). The control plane
 *   recomputes any cell's secrets on demand (nothing stored); a cell holding one
 *   tenant's secret cannot mint for another tenant.
 *
 * (The handoff-token codec that used to live here is gone: cells authenticate
 * browsers via their own OIDC login now — the control plane routes, it never
 * signs an identity.)
 */
import { createHmac, timingSafeEqual } from "node:crypto";

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
