/**
 * Git-provider abstraction — the RELEASE half of the provider seam: what the
 * Live Host does on a git host with the PLATFORM's credential (the App's
 * installation token) once a release is due: the authenticated push URL and
 * PR/MR creation. The release flow never mentions a concrete provider.
 *
 * There is no user-credentialed half any more (ADR 0007): people authenticate
 * at the IdP, and whether an identity may write a repository is answered
 * app-side by the sibling seam — src/ports/connection-source.ts
 * (RepoConnectionSource.checkUserPermission, ADR 0001). A GitLab port
 * implements BOTH interfaces; an early GitLab draft of the old user-OAuth
 * shape exists in git history (`08b6c20` era).
 *
 * Multi-repo (docs/multi-repo-architecture.md): the provider represents the
 * CONNECTION to a git host, not a repository — every repo-scoped capability
 * takes the target repo's full path per call (GitHub "owner/name", GitLab
 * "group/sub/project" — multi-segment paths are supported end to end).
 */

export interface GitUser {
  /** provider-unique login, e.g. "dominikhorn93" */
  login: string;
  name: string;
  avatarUrl: string | null;
  /** where the identity came from: "oidc" (the IdP login / a bearer JWT) or
   * "local" (a LIVE_AUTH=none host's principal) */
  provider: string;
}

export interface PullRequestRef {
  url: string;
  number: number;
}

export interface GitProvider {
  /** provider id — names the release's noreply attribution domain */
  readonly id: string;

  /** HTTPS remote URL for the given repo carrying the credential (`git push`). */
  pushUrl(token: string, repo: string): string;

  /** Open a pull/merge request on the given repo with the given credential —
   * the App's installation token, so the PR is bot-authored with the human as
   * git author (ADR 0001). */
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
