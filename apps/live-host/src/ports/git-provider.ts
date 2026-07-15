/**
 * Git-provider abstraction — the USER-credentialed half of the provider seam.
 *
 * Everything a provider does WITH THE USER'S GRANT lives here: OAuth dance
 * (incl. token refresh — GitHub App user tokens expire after 8h, GitLab OAuth
 * tokens always expire), permission check, push URL, PR/MR creation. The
 * release flow and the session layer never mention a concrete provider.
 *
 * The PLATFORM-credentialed half — where the connected-repo set comes from,
 * clone credentials, webhooks — is the sibling seam:
 * src/ports/connection-source.ts (RepoConnectionSource). A GitLab port
 * implements BOTH interfaces; an early GitLab draft of this one exists in git
 * history (`08b6c20` era, pre TokenGrant).
 *
 * Multi-repo (docs/multi-repo-architecture.md): the provider represents the
 * CONNECTION to a git host, not a repository — every repo-scoped capability
 * takes the target repo's full path per call (GitHub "owner/name", GitLab
 * "group/sub/project" — multi-segment paths are supported end to end).
 *
 * Identity vs. authorization: an SSO layer (e.g. WorkOS AuthKit) can sit in
 * front for *who you are*, but repository access always requires the git
 * provider's own OAuth grant — that grant is what this interface models.
 */

export interface GitUser {
  /** provider-unique login, e.g. "dominikhorn93" */
  login: string;
  name: string;
  avatarUrl: string | null;
  provider: string;
}

export interface PullRequestRef {
  url: string;
  number: number;
}

/**
 * Result of an OAuth code exchange (or refresh). GitHub Apps default to
 * expiring 8h user tokens, GitLab OAuth tokens always expire (2h) — a provider
 * that drops refreshToken/expiresAt strands sessions mid-day.
 */
export interface TokenGrant {
  accessToken: string;
  refreshToken?: string;
  /** epoch ms; undefined = the token does not expire */
  expiresAt?: number;
}

export interface GitProvider {
  /** id used in routes (/auth/<id>) and sessions */
  readonly id: string;
  /** human label for the login button */
  readonly label: string;

  /** Full authorize URL the browser is redirected to (includes state). */
  authorizeUrl(redirectUri: string, state: string): string;

  /** Exchange the callback code for the user's token grant. */
  exchangeCode(code: string, redirectUri: string): Promise<TokenGrant>;

  /** Refresh an expiring grant (absent when the provider's tokens never expire). */
  refreshGrant?(refreshToken: string): Promise<TokenGrant>;

  /** Fetch the authenticated user's identity. */
  fetchUser(token: string): Promise<GitUser>;

  /**
   * True if the user may write the given repository ("owner/name").
   * Per-(user,repo) authorization — the entry ticket for exactly that repo.
   */
  checkRepoAccess(token: string, user: GitUser, repo: string): Promise<boolean>;

  /** HTTPS remote URL for the given repo carrying the user's token (`git push`). */
  pushUrl(token: string, repo: string): string;

  /** Open a pull/merge request AS THE USER (their token) on the given repo. */
  createPullRequest(
    token: string,
    repo: string,
    args: {
      branch: string;
      base: string;
      title: string;
      body: string;
    },
  ): Promise<PullRequestRef>;
}
