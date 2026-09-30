/**
 * Per-(user,repo) authorization with a short-lived cache
 * (docs/multi-repo-architecture.md, E; auth model: docs/adr/0001 + 0007).
 *
 * Login only authenticates; whether a session may touch a repo is decided
 * here, per request / per ws room join — cached for 5 minutes per (session,
 * repo) so neither the HTTP API nor onAuthenticate hammers the provider.
 *
 * ONE authorization path (ADR 0001; the user-token fallback retired by ADR
 * 0007): the connection source answers app-side with the PLATFORM installation
 * token (collaborators/permission). No user token, no refresh, works even
 * after the person's IdP session would have expired. A repository the source
 * cannot answer for (no installation — the static fallback repo) is writable
 * by nobody.
 *
 * Two failure modes are kept apart:
 *   - the provider SAYS no   → deny, cache the denial
 *   - the check ERRORS       → fall back to the last known answer, never cache
 *     (a provider blip must not lock users out for 5 min)
 *
 * Concurrent checks for the same (session, repo) share ONE provider round
 * trip: the overview checks its repos in parallel (#212), and a room join may
 * ask for the same key meanwhile.
 */
import type { Session } from "../adapters/sqlite/sessions.ts";
import { permissionGrantsWrite, type RepoConnectionSource, type RepoPermission } from "../ports/connection-source.ts";
import type { ConnectedRepo } from "./registry.ts";

const TTL_MS = 5 * 60_000;

export class AccessCache {
  private readonly source?: RepoConnectionSource;
  private readonly cache = new Map<string, { ok: boolean; at: number }>();
  /** invalidate() drops the entries it covers — a round trip that straddled it
   *  answers its callers but must not repopulate the cache with a
   *  pre-invalidation answer; everyone else's still lands */
  private readonly inflight = new Map<string, Promise<boolean>>();

  constructor(source?: RepoConnectionSource) {
    this.source = source;
  }

  async canWrite(session: Session, repo: ConnectedRepo): Promise<boolean> {
    const key = `${session.id}:${repo.fullName.toLowerCase()}`;
    const hit = this.cache.get(key);
    if (hit && Date.now() - hit.at < TTL_MS) return hit.ok;

    if (!this.source?.checkUserPermission || repo.installationId === null) {
      // nothing can vouch for this identity on this repository — closed. Cached
      // like a denial: the answer only changes with the registry (whose syncs
      // invalidate this cache).
      console.log(`access check ${repo.fullName} for @${session.user.login}: no app installation to ask — denied`);
      this.cache.set(key, { ok: false, at: Date.now() });
      return false;
    }
    const pending = this.inflight.get(key);
    if (pending) return pending;
    const perm = this.source.checkUserPermission(repo.installationId, session.user.login, repo.fullName);
    const check = this.settle(perm, session, repo, hit, (ok) => {
      if (this.inflight.get(key) === check) this.cache.set(key, { ok, at: Date.now() });
    }).finally(() => {
      if (this.inflight.get(key) === check) this.inflight.delete(key);
    });
    this.inflight.set(key, check);
    return check;
  }

  private async settle(
    pending: Promise<RepoPermission>,
    session: Session,
    repo: ConnectedRepo,
    hit: { ok: boolean } | undefined,
    remember: (ok: boolean) => void,
  ): Promise<boolean> {
    try {
      const ok = permissionGrantsWrite(await pending);
      remember(ok);
      return ok;
    } catch (e) {
      console.log(
        `app-side access check ${repo.fullName} for @${session.user.login} errored ` +
          `(${(e as Error).message.split("\n")[0]}) — ${hit ? "reusing last known answer" : "denying, not cached"}`,
      );
      return hit?.ok ?? false;
    }
  }

  /**
   * Forget cached answers — all of them (e.g. after an installation webhook
   * changed the world), or only one session's (its explicit overview refresh:
   * the person asked for THEIR fresh state, which must not make every other
   * session's next overview pay the provider round trips again, #212).
   */
  invalidate(sessionId?: string): void {
    if (sessionId === undefined) {
      this.cache.clear();
      this.inflight.clear();
      return;
    }
    const prefix = `${sessionId}:`;
    for (const map of [this.cache, this.inflight]) {
      for (const key of map.keys()) if (key.startsWith(prefix)) map.delete(key);
    }
  }
}
