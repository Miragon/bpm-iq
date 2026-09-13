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
 */
import type { Session } from "../adapters/sqlite/sessions.ts";
import { permissionGrantsWrite, type RepoConnectionSource } from "../ports/connection-source.ts";
import type { ConnectedRepo } from "./registry.ts";

const TTL_MS = 5 * 60_000;

export class AccessCache {
  private readonly source?: RepoConnectionSource;
  private readonly cache = new Map<string, { ok: boolean; at: number }>();

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

  /** e.g. after an installation webhook changed the world */
  invalidate(): void {
    this.cache.clear();
  }
}
