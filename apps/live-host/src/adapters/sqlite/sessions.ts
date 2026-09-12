/**
 * Server-side sessions, SQLite-backed (same .live/live.db as the Yjs state).
 *
 * The session id is the only credential clients hold: as an httpOnly cookie
 * for the HTTP API and as the Hocuspocus connection token for the websocket.
 * A session is IDENTITY-ONLY (ADR 0001, completed by ADR 0007): no provider
 * credential is stored anywhere — per-repo authorization runs app-side on the
 * App's installation token, releases are bot-authored with human attribution.
 */
import { createHmac, randomBytes } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";

// shared primitives — identical wire formats, so states/cookies minted before
// this move keep verifying
import { readCookie as readCookieKit, tag, timingSafeStr, untag } from "@bpmiq/http-kit";

import type { GitUser } from "../../ports/git-provider.ts";

export interface Session {
  id: string;
  user: GitUser;
  createdAt: number;
}

export const COOKIE = "bpm_live_sid";
const MAX_AGE_MS = 1000 * 60 * 60 * 12; // 12h — a working day; re-grant afterwards

export class SessionStore {
  /** HMAC key for the OAuth `state`. DERIVED from a persistent secret when one is
   * configured (domain-separated "live-host:oauth-state") so a restart/redeploy
   * mid-login doesn't invalidate the in-flight state ("invalid OAuth state" — the
   * control plane derives for exactly this reason); random only in keyless dev. */
  private readonly stateSecret: Buffer;
  private readonly db: DatabaseSync;

  /** `secret` (SESSION_ENC_KEY) only feeds the state HMAC — nothing is encrypted
   *  any more, because nothing secret is stored */
  constructor(db: DatabaseSync, secret?: string) {
    this.db = db;
    this.stateSecret = secret ? createHmac("sha256", secret).update("live-host:oauth-state").digest() : randomBytes(32);
    db.exec(`CREATE TABLE IF NOT EXISTS sessions (
      id TEXT PRIMARY KEY,
      user TEXT NOT NULL,
      created_at INTEGER NOT NULL
    )`);
    // pre-ADR-0007 databases carry the stored-grant columns (provider_token NOT
    // NULL, refresh_token, token_expires_at): drop them in place — the rows
    // (identity + age) stay valid, nobody is signed out by the upgrade, and the
    // credentials they held are gone from disk for good
    const cols = new Set(
      (db.prepare("PRAGMA table_info(sessions)").all() as Array<{ name: string }>).map((c) => c.name),
    );
    for (const legacy of ["provider_token", "refresh_token", "token_expires_at"]) {
      if (cols.has(legacy)) db.exec(`ALTER TABLE sessions DROP COLUMN ${legacy}`);
    }
  }

  /** mint a session for an authenticated identity — the IdP login, or any
   *  future identity-only entrance (docs/extending/sso.md) */
  create(user: GitUser): Session {
    const id = randomBytes(24).toString("base64url");
    const createdAt = Date.now();
    this.db
      .prepare("INSERT INTO sessions (id, user, created_at) VALUES (?, ?, ?)")
      .run(id, JSON.stringify(user), createdAt);
    return { id, user, createdAt };
  }

  get(id: string | undefined): Session | undefined {
    if (!id) return undefined;
    const row = this.db.prepare("SELECT id, user, created_at FROM sessions WHERE id = ?").get(id) as
      { id: string; user: string; created_at: number } | undefined;
    if (!row) return undefined;
    if (Date.now() - row.created_at > MAX_AGE_MS) {
      this.delete(id);
      return undefined;
    }
    return { id: row.id, user: JSON.parse(row.user), createdAt: row.created_at };
  }

  delete(id: string): void {
    this.db.prepare("DELETE FROM sessions WHERE id = ?").run(id);
  }

  /** OAuth `state` bound to the initiating browser (login-CSRF / session-fixation
   * fix): a random nonce goes into BOTH the HMAC-signed state AND the returned value,
   * which the caller sets as a short-lived cookie. The callback requires both — so a
   * state minted in the attacker's browser can't complete a login in the victim's. */
  issueState(provider: string): { state: string; nonce: string } {
    const nonce = randomBytes(18).toString("base64url");
    return { state: tag(this.stateSecret, `${provider}.${nonce}`), nonce };
  }

  verifyState(state: string | null, provider: string, cookieNonce: string | undefined): boolean {
    if (!state || !cookieNonce) return false;
    // 1. we signed this state (untag splits at the LAST dot — the payload's own
    //    "provider.nonce" dot is fine) …
    const payload = untag(this.stateSecret, state);
    if (!payload?.startsWith(`${provider}.`)) return false;
    // 2. … and it is bound to THIS browser (nonce in the state matches the cookie)
    return timingSafeStr(payload.slice(provider.length + 1), cookieNonce);
  }
}

/** the browser-binding cookie for the OAuth `state` nonce (login-CSRF fix) */
export const OAUTH_COOKIE = "bpm_live_oauth";
export function oauthCookie(nonce: string, secure: boolean): string {
  return `${OAUTH_COOKIE}=${nonce}; Path=/; HttpOnly; SameSite=Lax; Max-Age=600${secure ? "; Secure" : ""}`;
}
export function clearOauthCookie(secure: boolean): string {
  return `${OAUTH_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0${secure ? "; Secure" : ""}`;
}

/** the PKCE code_verifier for the OIDC browser login — browser-bound (HttpOnly,
 * one flow's lifetime) exactly like the state nonce; the callback needs it for
 * the token exchange and clears it */
export const PKCE_COOKIE = "bpm_live_pkce";
export function pkceCookie(verifier: string, secure: boolean): string {
  return `${PKCE_COOKIE}=${verifier}; Path=/; HttpOnly; SameSite=Lax; Max-Age=600${secure ? "; Secure" : ""}`;
}
export function clearPkceCookie(secure: boolean): string {
  return `${PKCE_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0${secure ? "; Secure" : ""}`;
}

/** the editor sign-in's (scheme, nonce) pair (http/editor-login.ts) —
 * browser-bound for one flow exactly like the state nonce; the callback reads it
 * to land in the editor instead of setting the session cookie, then clears it */
export const EDITOR_COOKIE = "bpm_live_editor";
export function editorCookie(value: string, secure: boolean): string {
  return `${EDITOR_COOKIE}=${value}; Path=/; HttpOnly; SameSite=Lax; Max-Age=600${secure ? "; Secure" : ""}`;
}
export function clearEditorCookie(secure: boolean): string {
  return `${EDITOR_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0${secure ? "; Secure" : ""}`;
}

export const readCookie = readCookieKit;

export function sessionCookie(id: string, secure: boolean): string {
  return `${COOKIE}=${id}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${MAX_AGE_MS / 1000}${secure ? "; Secure" : ""}`;
}

export function clearCookie(): string {
  return `${COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`;
}
