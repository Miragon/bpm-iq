/**
 * Server-side sessions, SQLite-backed (same .live/live.db as the Yjs state).
 *
 * The session id is the only credential clients hold: as an httpOnly cookie
 * for the HTTP API and as the Hocuspocus connection token for the websocket.
 * The provider access token never leaves the server.
 */
import { createHmac, randomBytes } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";

import { verifyHandoff as verifyHandoffToken } from "@bpmiq/cell-protocol";
// shared primitives — identical wire formats, so states/cookies minted before
// this move keep verifying
import { readCookie as readCookieKit, tag, timingSafeStr, untag } from "@bpmiq/http-kit";

import { type Cipher, makeCipher } from "../../domain/crypt.ts";
import type { GitUser, TokenGrant } from "../../ports/git-provider.ts";

export interface Session {
  id: string;
  user: GitUser;
  /** git-provider access token — server-side only, never serialized to clients */
  providerToken: string;
  /** provider refresh token (expiring grants, e.g. GitHub App 8h user tokens) */
  refreshToken?: string;
  /** provider token expiry (epoch ms); undefined = non-expiring */
  tokenExpiresAt?: number;
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
  /** at-rest cipher for the stored provider tokens (undefined = no key → cleartext,
   * dev only). A leaked live.db volume then yields no usable GitHub credential. */
  private readonly cipher: Cipher | undefined;

  constructor(db: DatabaseSync, encryptionKey?: string) {
    this.db = db;
    this.stateSecret = encryptionKey
      ? createHmac("sha256", encryptionKey).update("live-host:oauth-state").digest()
      : randomBytes(32);
    this.cipher = makeCipher(encryptionKey);
    db.exec(`CREATE TABLE IF NOT EXISTS sessions (
      id TEXT PRIMARY KEY,
      user TEXT NOT NULL,
      provider_token TEXT NOT NULL,
      created_at INTEGER NOT NULL
    )`);
    // grant columns arrived after the first deployments — migrate in place
    const cols = new Set(
      (db.prepare("PRAGMA table_info(sessions)").all() as Array<{ name: string }>).map((c) => c.name),
    );
    if (!cols.has("refresh_token")) db.exec("ALTER TABLE sessions ADD COLUMN refresh_token TEXT");
    if (!cols.has("token_expires_at")) db.exec("ALTER TABLE sessions ADD COLUMN token_expires_at INTEGER");
    // redeemed handoff-token ids (single-use): a captured token can't be replayed
    db.exec("CREATE TABLE IF NOT EXISTS consumed_handoffs (jti TEXT PRIMARY KEY, exp INTEGER NOT NULL)");
  }

  /** encrypt a provider token for storage (empty/null pass through — nothing to hide) */
  private seal(v: string | null): string | null {
    if (!v) return v;
    return this.cipher ? this.cipher.enc(v) : v;
  }
  /** decrypt a stored provider token; an undecryptable value (rotated key or a legacy
   * cleartext row once a key is configured) → "" so the caller re-authenticates */
  private open(v: string | null): string | null {
    if (!v) return v;
    return this.cipher ? (this.cipher.dec(v) ?? "") : v;
  }

  /**
   * Create a session. `grant` is optional: a handoff login (ADR 0001/0002 cell
   * mode) establishes identity WITHOUT a stored user token — authorization then
   * runs entirely app-side (installation token). Such a session has an empty
   * providerToken; the (Phase-3 bot-authored) release flow no longer needs it.
   */
  create(user: GitUser, grant?: TokenGrant): Session {
    const id = randomBytes(24).toString("base64url");
    const createdAt = Date.now();
    this.db
      .prepare(
        "INSERT INTO sessions (id, user, provider_token, refresh_token, token_expires_at, created_at) VALUES (?, ?, ?, ?, ?, ?)",
      )
      .run(
        id,
        JSON.stringify(user),
        this.seal(grant?.accessToken ?? "") ?? "",
        this.seal(grant?.refreshToken ?? null),
        grant?.expiresAt ?? null,
        createdAt,
      );
    return {
      id,
      user,
      providerToken: grant?.accessToken ?? "",
      refreshToken: grant?.refreshToken,
      tokenExpiresAt: grant?.expiresAt,
      createdAt,
    };
  }

  /**
   * Verify a control-plane handoff token (the shared @bpmiq/cell-protocol codec),
   * returning its identity + single-use id + expiry, or undefined if invalid/expired.
   * Single-use enforcement is `consumeHandoff` below (it needs storage).
   */
  verifyHandoff(token: string | null, secret: string): (GitUser & { jti?: string; handoffExp: number }) | undefined {
    const claims = verifyHandoffToken(token, secret);
    if (!claims) return undefined;
    const { exp, jti, ...identity } = claims;
    return { ...identity, jti, handoffExp: exp };
  }

  /**
   * Redeem a handoff token's unique id — returns true only the FIRST time, so an
   * intercepted token can't be replayed even inside its (60s) TTL. Expired ids are
   * pruned opportunistically; the store is tiny and self-cleaning.
   */
  consumeHandoff(jti: string, expMs: number): boolean {
    this.db.prepare("DELETE FROM consumed_handoffs WHERE exp < ?").run(Date.now());
    const r = this.db.prepare("INSERT OR IGNORE INTO consumed_handoffs (jti, exp) VALUES (?, ?)").run(jti, expMs);
    return r.changes > 0;
  }

  /** persist a refreshed grant (and update the caller's session object) */
  updateGrant(session: Session, grant: TokenGrant): void {
    this.db
      .prepare("UPDATE sessions SET provider_token = ?, refresh_token = ?, token_expires_at = ? WHERE id = ?")
      .run(
        this.seal(grant.accessToken) ?? "",
        this.seal(grant.refreshToken ?? session.refreshToken ?? null),
        grant.expiresAt ?? null,
        session.id,
      );
    session.providerToken = grant.accessToken;
    if (grant.refreshToken) session.refreshToken = grant.refreshToken;
    session.tokenExpiresAt = grant.expiresAt;
  }

  get(id: string | undefined): Session | undefined {
    if (!id) return undefined;
    const row = this.db.prepare("SELECT * FROM sessions WHERE id = ?").get(id) as
      | {
          id: string;
          user: string;
          provider_token: string;
          refresh_token: string | null;
          token_expires_at: number | null;
          created_at: number;
        }
      | undefined;
    if (!row) return undefined;
    if (Date.now() - row.created_at > MAX_AGE_MS) {
      this.delete(id);
      return undefined;
    }
    return {
      id: row.id,
      user: JSON.parse(row.user),
      providerToken: this.open(row.provider_token) ?? "",
      refreshToken: this.open(row.refresh_token) ?? undefined,
      tokenExpiresAt: row.token_expires_at ?? undefined,
      createdAt: row.created_at,
    };
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

export const readCookie = readCookieKit;

export function sessionCookie(id: string, secure: boolean): string {
  return `${COOKIE}=${id}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${MAX_AGE_MS / 1000}${secure ? "; Secure" : ""}`;
}

export function clearCookie(): string {
  return `${COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`;
}
