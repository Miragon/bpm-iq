/**
 * RepoConnectionSource — the second provider seam (docs/multi-repo-architecture.md).
 *
 * GitProvider (ports/git-provider.ts) models the USER-credentialed half: OAuth,
 * permission gate, push, PR. THIS interface models the PLATFORM-credentialed
 * half: where the set of connected repositories comes from and how the server
 * clones them. GitHub implements it with the App mechanics (installations,
 * installation tokens, install picker, HMAC webhooks). GitLab has none of
 * those concepts — its source will be an OAuth application + explicit project
 * selection (or group access tokens) and X-Gitlab-Token webhooks — but the
 * registry and the API only ever talk to this interface.
 */

export interface SourceRepo {
  /** provider-unique full path ("owner/name"; GitLab: "group/sub/project") */
  fullName: string;
  defaultBranch: string;
  private: boolean;
  avatarUrl: string | null;
  /** provider-specific connection handle (GitHub: installation id) */
  connectionRef: number;
}

export interface ConnectionSnapshot {
  repos: SourceRepo[];
  /** every connection ref that EXISTS upstream (enumerated or not) — a repo
   *  whose ref is missing here was uninstalled and gets pruned */
  knownRefs: Set<number>;
  /** refs that were FULLY enumerated — only their repos may be pruned by name */
  enumeratedRefs: Set<number>;
  /** refs whose connection is suspended (repos stay, flagged) */
  suspendedRefs: Set<number>;
}

export interface WebhookVerdict {
  /** signature/token valid? false = reject the request */
  authentic: boolean;
  /** does this event change the connected-repo set (→ resync)? */
  membershipChanged: boolean;
}

/** a user's effective permission on a repo (GitHub's collaborator-permission levels) */
export type RepoPermission = "admin" | "maintain" | "write" | "read" | "none";
const WRITE_LEVELS: ReadonlySet<RepoPermission> = new Set(["admin", "maintain", "write"]);
export const permissionGrantsWrite = (p: RepoPermission): boolean => WRITE_LEVELS.has(p);

export interface RepoConnectionSource {
  /** id used in logs ("github-app") */
  readonly id: string;
  /** false = no platform credentials: connectUrl/webhooks may still work, but
   *  the connected-repo set cannot be enumerated (listConnectedRepos throws) */
  readonly canEnumerate: boolean;
  /** authoritative snapshot of the connected-repo set */
  listConnectedRepos(): Promise<ConnectionSnapshot>;
  /** short-lived credential for server-side git clone/fetch of ONE repo */
  cloneToken(connectionRef: number | null): Promise<string | undefined>;
  /** where a user connects more repos (GitHub: the app's install picker) */
  connectUrl(): string | undefined;
  /** verify + classify an incoming webhook; undefined = webhooks not configured */
  verifyWebhook(headers: Record<string, string | string[] | undefined>, rawBody: Buffer): WebhookVerdict | undefined;
  /**
   * A user's effective permission on a repo, resolved with the PLATFORM's
   * installation token — no user token needed (ADR 0001). undefined = this
   * source cannot answer app-side (caller falls back to the user-token path).
   */
  checkUserPermission?(connectionRef: number, username: string, repo: string): Promise<RepoPermission>;
}
