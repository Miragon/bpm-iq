/**
 * Installation-token minting seam (ADR 0002).
 *
 * A cell needs 1h installation tokens to clone/fetch repos and to answer
 * authorization app-side. Two ways to get them:
 *
 *   LOCAL   — this process holds the GitHub App private key and signs an app
 *             JWT to mint tokens itself (today's single-instance / dev mode).
 *   REMOTE  — the App private key lives ONLY in the control plane; the cell
 *             POSTs {installationId} to the control plane's mint endpoint with
 *             its per-cell secret and gets back a token scoped to its tenant.
 *             The key never lives in a cell (ADR 0002 blast-radius property).
 *
 * Either way, TokenService caches in memory (refresh 5 min early) and — the
 * degraded-mode requirement (ADR 0002 blocker T) — persists the last token to
 * SQLite so a cell woken during a control-plane blip serves existing users
 * with a still-valid token instead of failing closed. At rest the token is
 * encrypted with CELL_TOKEN_KEY when set (a 1h installation token is far less
 * sensitive than a user credential, but the volume is per-tenant either way).
 */
import type { DatabaseSync } from "node:sqlite";

import { mintInstallationToken } from "@bpmiq/github-app";

import { type AppCredentials, githubApi } from "../adapters/github/app-auth.ts";
import { makeCipher } from "../domain/crypt.ts";

export interface MintedToken {
  token: string;
  /** epoch ms */
  expiresAt: number;
}

/** the raw way tokens are obtained — local (app key) or remote (control plane) */
export type MintFn = (installationId: number) => Promise<MintedToken>;

/** LOCAL: sign an app JWT and mint via GitHub directly (shared plumbing). */
export function localMintFn(creds: AppCredentials): MintFn {
  return (installationId) => mintInstallationToken(creds, githubApi(creds.apiUrl), installationId);
}

/** REMOTE: ask the control plane to mint a token for THIS cell's tenant.
 * A hung control plane must not block room-joins indefinitely and mask the
 * degraded-mode fallback — so the request is bounded by a timeout. */
export function remoteMintFn(mintUrl: string, cellSecret: string, timeoutMs = 10_000): MintFn {
  return async (installationId) => {
    const res = await fetch(mintUrl, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${cellSecret}` },
      body: JSON.stringify({ installationId }),
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok)
      throw new Error(`control-plane token mint for ${installationId} failed: ${res.status} ${await res.text()}`);
    const body = (await res.json()) as { token: string; expiresAt: number };
    return { token: body.token, expiresAt: body.expiresAt };
  };
}

export class TokenService {
  private readonly mem = new Map<number, MintedToken>();
  private readonly mintFn: MintFn;
  private readonly cipher: ReturnType<typeof makeCipher>;
  private readonly load?: (id: number) => { token: string; expires_at: number } | undefined;
  private readonly save?: (id: number, token: string, expiresAt: number) => void;
  /** in-flight mints per installation — collapses a room-join stampede into one
   * upstream request instead of one GitHub POST per concurrent joiner */
  private readonly inflight = new Map<number, Promise<string>>();
  /** proactive-refresh timers (one per installation) */
  private readonly timers = new Map<number, ReturnType<typeof setTimeout>>();
  private readonly proactive: boolean;
  private readonly refreshLeadMs: number;
  /** how soon to retry a FAILED proactive refresh — keeps the chain alive so a
   * transient mint outage doesn't permanently disable proactive mode */
  private readonly retryMs: number;

  constructor(
    mintFn: MintFn,
    opts: {
      db?: DatabaseSync;
      encryptionKey?: string;
      proactive?: boolean;
      refreshLeadMs?: number;
      retryMs?: number;
    } = {},
  ) {
    this.mintFn = mintFn;
    this.cipher = makeCipher(opts.encryptionKey);
    this.proactive = opts.proactive === true;
    this.refreshLeadMs = opts.refreshLeadMs ?? 10 * 60_000;
    this.retryMs = opts.retryMs ?? 60_000;
    if (opts.db) {
      opts.db.exec(
        "CREATE TABLE IF NOT EXISTS installation_tokens (installation_id INTEGER PRIMARY KEY, token TEXT NOT NULL, expires_at INTEGER NOT NULL)",
      );
      const loadStmt = opts.db.prepare("SELECT token, expires_at FROM installation_tokens WHERE installation_id = ?");
      const saveStmt = opts.db.prepare(
        "INSERT INTO installation_tokens (installation_id, token, expires_at) VALUES (?, ?, ?) ON CONFLICT(installation_id) DO UPDATE SET token = excluded.token, expires_at = excluded.expires_at",
      );
      this.load = (id) => loadStmt.get(id) as { token: string; expires_at: number } | undefined;
      this.save = (id, token, expiresAt) => saveStmt.run(id, token, expiresAt);
    }
  }

  /** a valid token for the installation; may serve a persisted one if minting is down */
  async mint(installationId: number): Promise<string> {
    const memo = this.mem.get(installationId);
    if (memo && memo.expiresAt - Date.now() > 5 * 60_000) return memo.token;
    return this.refresh(installationId);
  }

  /** single-flight refresh: concurrent callers share one upstream mint */
  private refresh(installationId: number): Promise<string> {
    const existing = this.inflight.get(installationId);
    if (existing) return existing;
    const p = this.doMint(installationId).finally(() => this.inflight.delete(installationId));
    this.inflight.set(installationId, p);
    return p;
  }

  private async doMint(installationId: number): Promise<string> {
    try {
      const fresh = await this.mintFn(installationId);
      this.mem.set(installationId, fresh);
      this.persist(installationId, fresh);
      // re-arm the proactive timer for ~refreshLead before the new expiry
      this.arm(installationId, fresh.expiresAt - Date.now() - this.refreshLeadMs);
      return fresh.token;
    } catch (e) {
      // keep the proactive chain ALIVE: a single failed refresh must not disable
      // it (the whole point — bound the degraded window). Re-arm a short retry so
      // it keeps trying until the mint endpoint recovers.
      this.arm(installationId, this.retryMs);
      const stored = this.loadPersisted(installationId);
      // serve a persisted token only while it is comfortably valid (>1 min left)
      if (stored && stored.expiresAt - Date.now() > 60_000) {
        console.log(
          `token mint for ${installationId} failed (${(e as Error).message.split("\n")[0]}) — ` +
            `serving persisted token (valid ~${Math.round((stored.expiresAt - Date.now()) / 60_000)} min)`,
        );
        this.mem.set(installationId, stored);
        return stored.token;
      }
      throw e;
    }
  }

  /** (re)arm the proactive-refresh timer so the cached token is always fresh —
   * bounds the degraded window to ~refreshLead (or ~retry after a failure) instead
   * of a random 0–60 min (ADR 0002 blocker T). No-op unless `proactive` is on. */
  private arm(installationId: number, delayMs: number): void {
    if (!this.proactive) return;
    const prev = this.timers.get(installationId);
    if (prev) clearTimeout(prev);
    const timer = setTimeout(() => void this.refresh(installationId).catch(() => undefined), Math.max(1_000, delayMs));
    timer.unref?.();
    this.timers.set(installationId, timer);
  }

  /** stop all proactive-refresh timers (graceful shutdown / tests) */
  stop(): void {
    for (const t of this.timers.values()) clearTimeout(t);
    this.timers.clear();
  }

  private persist(id: number, t: MintedToken): void {
    if (!this.save) return;
    this.save(id, this.cipher ? this.cipher.enc(t.token) : t.token, t.expiresAt);
  }

  private loadPersisted(id: number): MintedToken | undefined {
    const row = this.load?.(id);
    if (!row) return undefined;
    const token = this.cipher ? this.cipher.dec(row.token) : row.token;
    return token ? { token, expiresAt: row.expires_at } : undefined;
  }
}
