/**
 * Connected-repository registry (docs/multi-repo-architecture.md, B).
 *
 * The set of connected repos is DERIVED, not configured:
 *   primary source  — a RepoConnectionSource (GitHub: the central App's
 *                     installations), kept fresh by webhooks + /setup/installed
 *                     + requestSync()
 *   fallback source — the host's own repo (GITHUB_REPO) when no source
 *                     credentials are available yet (single-repo mode)
 *
 * Persisted in SQLite so the overview works across restarts even when the
 * provider is briefly unreachable. Deletions only happen for connections that
 * were FULLY enumerated — a transient listing failure never disconnects a repo.
 */
import type { DatabaseSync } from "node:sqlite";

import type { RepoConnectionSource } from "../ports/connection-source.ts";

export interface ConnectedRepo {
  /** provider-unique full path ("owner/name"; GitLab: "group/sub/project") */
  fullName: string;
  defaultBranch: string;
  private: boolean;
  avatarUrl: string | null;
  /** null for the static fallback entry (host repo without source credentials) */
  installationId: number | null;
  suspended: boolean;
}

export class RepoRegistry {
  private readonly db: DatabaseSync;
  private readonly source: RepoConnectionSource | undefined;
  private lastSyncAt = 0;
  private inFlight: Promise<void> | null = null;

  constructor(db: DatabaseSync, source: RepoConnectionSource | undefined, staticRepo: string | undefined) {
    this.db = db;
    this.source = source;
    db.exec(`CREATE TABLE IF NOT EXISTS repos (
      full_name TEXT PRIMARY KEY,
      default_branch TEXT NOT NULL,
      private INTEGER NOT NULL DEFAULT 1,
      avatar_url TEXT,
      installation_id INTEGER,
      suspended INTEGER NOT NULL DEFAULT 0
    )`);
    if (staticRepo) {
      // fallback entry so a credential-less instance keeps serving its own repo
      this.db
        .prepare(
          "INSERT INTO repos (full_name, default_branch, installation_id) VALUES (?, ?, NULL) ON CONFLICT(full_name) DO NOTHING",
        )
        .run(staticRepo, process.env.BASE_BRANCH ?? "main");
    }
  }

  get appConfigured(): boolean {
    return this.source?.canEnumerate ?? false;
  }

  list(): ConnectedRepo[] {
    const rows = this.db.prepare("SELECT * FROM repos ORDER BY full_name").all() as Array<{
      full_name: string;
      default_branch: string;
      private: number;
      avatar_url: string | null;
      installation_id: number | null;
      suspended: number;
    }>;
    return rows.map((r) => ({
      fullName: r.full_name,
      defaultBranch: r.default_branch,
      private: r.private === 1,
      avatarUrl: r.avatar_url,
      installationId: r.installation_id,
      suspended: r.suspended === 1,
    }));
  }

  get(fullName: string): ConnectedRepo | undefined {
    return this.list().find((r) => r.fullName.toLowerCase() === fullName.toLowerCase());
  }

  /**
   * Coalesced sync: at most one enumeration in flight. Unauthenticated triggers
   * (/setup/installed, webhooks) pass force=false and reuse a sync from the last
   * 10s — so they can't amplify into provider API floods. A logged-in user's
   * explicit "refresh" passes force=true to bypass that window (still
   * single-flighted), so a just-added repo shows up immediately.
   */
  requestSync(force = false): Promise<void> {
    if (this.inFlight) return this.inFlight;
    if (!force && Date.now() - this.lastSyncAt < 10_000) return Promise.resolve();
    this.inFlight = this.sync()
      .then(() => {
        this.lastSyncAt = Date.now();
      })
      .finally(() => {
        this.inFlight = null;
      });
    return this.inFlight;
  }

  /** Re-enumerate the connected-repo set from the source. No-op without one. */
  async sync(): Promise<void> {
    if (!this.source?.canEnumerate) return;
    const snapshot = await this.source.listConnectedRepos();

    for (const ref of snapshot.suspendedRefs) {
      this.db.prepare("UPDATE repos SET suspended = 1 WHERE installation_id = ?").run(ref);
    }
    const seen = new Set<string>();
    for (const r of snapshot.repos) {
      seen.add(r.fullName);
      this.db
        .prepare(
          `INSERT INTO repos (full_name, default_branch, private, avatar_url, installation_id, suspended)
        VALUES (?, ?, ?, ?, ?, 0)
        ON CONFLICT(full_name) DO UPDATE SET
          default_branch = excluded.default_branch, private = excluded.private,
          avatar_url = excluded.avatar_url, installation_id = excluded.installation_id, suspended = 0`,
        )
        .run(r.fullName, r.defaultBranch, r.private ? 1 : 0, r.avatarUrl, r.connectionRef);
    }
    // prune in exactly two cases, keep everything else:
    //   1. the connection was FULLY enumerated and no longer contains the repo
    //   2. the connection does not exist upstream at all anymore (uninstalled) —
    //      previously these repos stayed connected forever
    // a connection that exists but failed to list (known, not enumerated) is a
    // transient error and never prunes
    for (const existing of this.list()) {
      if (existing.installationId === null) continue; // static fallback stays
      const uninstalled = !snapshot.knownRefs.has(existing.installationId);
      const removedFromConnection =
        !existing.suspended && snapshot.enumeratedRefs.has(existing.installationId) && !seen.has(existing.fullName);
      if (uninstalled || removedFromConnection) {
        this.db.prepare("DELETE FROM repos WHERE full_name = ?").run(existing.fullName);
        console.log(`repo disconnected: ${existing.fullName}${uninstalled ? " (connection uninstalled)" : ""}`);
      }
    }
    console.log(`registry sync: ${this.list().length} connected repo(s)`);
  }

  /** Clone/fetch credential for a repo's server-side git operations. */
  async tokenFor(repo: ConnectedRepo): Promise<string | undefined> {
    return this.source?.cloneToken(repo.installationId);
  }
}
