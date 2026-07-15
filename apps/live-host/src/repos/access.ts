/**
 * Per-(user,repo) authorization with a short-lived cache
 * (docs/multi-repo-architecture.md, E; auth model: docs/adr/0001).
 *
 * Login only authenticates; whether a session may touch a repo is decided
 * here, per request / per ws room join — cached for 5 minutes per (session,
 * repo) so neither the HTTP API nor onAuthenticate hammers the provider.
 *
 * TWO authorization paths:
 *   1. PREFERRED (ADR 0001) — the connection source answers app-side with the
 *      PLATFORM installation token (collaborators/permission). No user token,
 *      no refresh, works even after the user's token would have expired.
 *   2. FALLBACK — the user-token path via GitProvider.checkRepoAccess, for
 *      providers/sources that cannot answer app-side. Expiring grants are
 *      refreshed transparently; a failed refresh deletes the session.
 *
 * Two failure modes are kept apart in both paths:
 *   - the provider SAYS no   → deny, cache the denial
 *   - the check ERRORS       → fall back to the last known answer, never cache
 *     (a provider blip must not lock users out for 5 min)
 */
import type { Session, SessionStore } from "../adapters/sqlite/sessions.ts";
import { permissionGrantsWrite, type RepoConnectionSource } from "../ports/connection-source.ts";
import type { GitProvider } from "../ports/git-provider.ts";
import type { ConnectedRepo } from "./registry.ts";

const TTL_MS = 5 * 60_000;
/** refresh this long before the token actually expires */
const REFRESH_MARGIN_MS = 5 * 60_000;

export class AccessCache {
  private readonly provider: GitProvider;
  private readonly sessions?: SessionStore;
  private readonly source?: RepoConnectionSource;
  private readonly cache = new Map<string, { ok: boolean; at: number }>();

  constructor(provider: GitProvider, sessions?: SessionStore, source?: RepoConnectionSource) {
    this.provider = provider;
    this.sessions = sessions;
    this.source = source;
  }

  async canWrite(session: Session, repo: ConnectedRepo): Promise<boolean> {
    const key = `${session.id}:${repo.fullName.toLowerCase()}`;
    const hit = this.cache.get(key);
    if (hit && Date.now() - hit.at < TTL_MS) return hit.ok;

    // Path 1 (preferred): app-side check, no user token involved
    if (this.source?.checkUserPermission && repo.installationId !== null) {
      try {
        const perm = await this.source.checkUserPermission(repo.installationId, session.user.login, repo.fullName);
        const ok = permissionGrantsWrite(perm);
        this.cache.set(key, { ok, at: Date.now() });
        return ok;
      } catch (e) {
        console.log(
          `app-side access check ${repo.fullName} for @${session.user.login} errored ` +
            `(${(e as Error).message.split("\n")[0]}) — ${hit ? "reusing last known answer" : "denying, not cached"}`,
        );
        return hit?.ok ?? false;
      }
    }

    // Path 2 (fallback): user-token check (legacy / non-GitHub providers)
    if (!(await this.refreshIfExpiring(session))) return false;
    try {
      const ok = await this.provider.checkRepoAccess(session.providerToken, session.user, repo.fullName);
      this.cache.set(key, { ok, at: Date.now() });
      return ok;
    } catch (e) {
      console.log(
        `access check ${repo.fullName} for @${session.user.login} errored (${(e as Error).message.split("\n")[0]}) — ` +
          (hit ? "reusing last known answer" : "denying this request, not cached"),
      );
      return hit?.ok ?? false;
    }
  }

  /** true = token usable; false = grant gone, session deleted */
  private async refreshIfExpiring(session: Session): Promise<boolean> {
    if (!session.tokenExpiresAt) return true; // non-expiring grant
    if (session.tokenExpiresAt - Date.now() > REFRESH_MARGIN_MS) return true;
    if (!session.refreshToken || !this.provider.refreshGrant) {
      if (session.tokenExpiresAt <= Date.now()) {
        console.log(`token of @${session.user.login} expired and cannot be refreshed — session invalidated`);
        this.sessions?.delete(session.id);
        return false;
      }
      return true; // inside the margin but still valid
    }
    try {
      const grant = await this.provider.refreshGrant(session.refreshToken);
      this.sessions?.updateGrant(session, grant);
      console.log(`token refreshed for @${session.user.login}`);
      return true;
    } catch (e) {
      console.log(
        `token refresh for @${session.user.login} failed (${(e as Error).message.split("\n")[0]}) — session invalidated`,
      );
      this.sessions?.delete(session.id);
      return false;
    }
  }

  /** e.g. after an installation webhook changed the world */
  invalidate(): void {
    this.cache.clear();
  }
}
