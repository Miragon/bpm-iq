/**
 * GitHub implementation of the GitProvider interface (the release half of the
 * provider seam — push URL + PR creation on the App's installation token).
 *
 * Base URLs are configurable so the SAME code serves github.com, GitHub
 * Enterprise, and the test stub (test/stub-provider.ts):
 *   GITHUB_BASE_URL  (default https://github.com)      — push remotes
 *   GITHUB_API_URL   (default https://api.github.com)  — REST
 *
 * The provider represents the GitHub connection; every repo-scoped call takes
 * the target repo ("owner/name") explicitly (multi-repo).
 */
import type { GitProvider, PullRequestRef } from "../../ports/git-provider.ts";

export interface GitHubConfig {
  baseUrl?: string;
  apiUrl?: string;
}

export function createGitHubProvider(cfg: GitHubConfig = {}): GitProvider {
  const base = (cfg.baseUrl ?? "https://github.com").replace(/\/$/, "");
  const api = (cfg.apiUrl ?? "https://api.github.com").replace(/\/$/, "");

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
