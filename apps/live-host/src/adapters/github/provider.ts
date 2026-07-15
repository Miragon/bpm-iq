/**
 * GitHub implementation of the GitProvider interface.
 *
 * Base URLs are configurable so the SAME code serves github.com, GitHub
 * Enterprise, and the test stub (test/stub-provider.ts):
 *   GITHUB_BASE_URL  (default https://github.com)      — OAuth authorize
 *   GITHUB_API_URL   (default https://api.github.com)  — REST
 *
 * The OAuth dance (authorize URL, code exchange, refresh, /user) is the shared
 * plumbing in @bpmiq/github-app/oauth (same wire the control plane speaks);
 * the repo-scoped capabilities (access check, push URL, PRs) stay app-local.
 * The provider represents the GitHub connection; every repo-scoped call takes
 * the target repo ("owner/name") explicitly (multi-repo).
 */
import { authorizeUrl, exchangeCode, fetchUser, type OAuthApp, refreshGrant } from "@bpmiq/github-app/oauth";

import type { GitProvider, GitUser, PullRequestRef } from "../../ports/git-provider.ts";
import { githubApi } from "./app-auth.ts";

export interface GitHubConfig {
  clientId: string;
  clientSecret: string;
  baseUrl?: string;
  apiUrl?: string;
  /**
   * true when the credentials belong to a GitHub App (manifest flow): the
   * authorize URL then omits `scope` — permissions come from the app itself
   * (fine-grained, installation-bound) instead of the coarse `repo` scope.
   */
  appMode?: boolean;
}

export function createGitHubProvider(cfg: GitHubConfig): GitProvider {
  const base = (cfg.baseUrl ?? "https://github.com").replace(/\/$/, "");
  const api = (cfg.apiUrl ?? "https://api.github.com").replace(/\/$/, "");
  const oauth: OAuthApp = { clientId: cfg.clientId, clientSecret: cfg.clientSecret, baseUrl: base };

  const rest = async (token: string, path: string, init: RequestInit = {}): Promise<Response> =>
    fetch(`${api}${path}`, {
      ...init,
      headers: {
        accept: "application/vnd.github+json",
        authorization: `Bearer ${token}`,
        "user-agent": "bpm-live-host",
        ...(init.headers ?? {}),
      },
    });

  return {
    id: "github",
    label: "GitHub",

    authorizeUrl(redirectUri, state) {
      // app mode: NO scope — permissions come from the app (fine-grained,
      // installation-bound) instead of the coarse `repo` scope
      return authorizeUrl(oauth, redirectUri, state, cfg.appMode ? {} : { scope: "repo" });
    },

    async exchangeCode(code, redirectUri) {
      return exchangeCode(oauth, code, redirectUri);
    },

    // GitHub Apps default to expiring user tokens (8h + refresh token) — without
    // this, a 12h session outlives its token and every access check turns into
    // a silent "no access" mid-day
    async refreshGrant(refreshToken) {
      return refreshGrant(oauth, refreshToken);
    },

    async fetchUser(token) {
      return (await fetchUser(githubApi(api), token)) satisfies GitUser;
    },

    async checkRepoAccess(token, user, repo) {
      // GET /repos/{owner}/{repo} works with metadata:read (unlike the
      // collaborators/permission endpoint, which needs app permissions our
      // fine-grained app deliberately doesn't request) and returns the
      // EFFECTIVE permissions of the authenticated user. A 404 also means
      // "app not installed on this repository" — same verdict, clear log.
      const res = await rest(token, `/repos/${repo}`);
      if (!res.ok) {
        console.log(
          `repo access check failed for @${user.login}: GET /repos/${repo} → ${res.status} (app installed on the repo?)`,
        );
        return false;
      }
      const body = (await res.json()) as { permissions?: { admin?: boolean; maintain?: boolean; push?: boolean } };
      const ok =
        body.permissions?.push === true || body.permissions?.maintain === true || body.permissions?.admin === true;
      if (!ok)
        console.log(
          `repo access check: @${user.login} has no push permission on ${repo} (${JSON.stringify(body.permissions)})`,
        );
      return ok;
    },

    pushUrl(token, repo) {
      // protocol follows the configured base URL (https for github.com/GHE,
      // http for the local stub)
      const proto = base.startsWith("http://") ? "http" : "https";
      return `${proto}://x-access-token:${token}@${base.replace(/^https?:\/\//, "")}/${repo}.git`;
    },

    async createPullRequest(token, repo, { branch, base: baseBranch, title, body }) {
      const res = await rest(token, `/repos/${repo}/pulls`, {
        method: "POST",
        body: JSON.stringify({ head: branch, base: baseBranch, title, body }),
      });
      if (!res.ok) throw new Error(`GitHub PR creation failed: ${res.status} ${await res.text()}`);
      const pr = (await res.json()) as { html_url: string; number: number };
      return { url: pr.html_url, number: pr.number } satisfies PullRequestRef;
    },
  };
}
