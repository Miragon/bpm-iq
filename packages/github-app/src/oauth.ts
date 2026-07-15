/**
 * @bpmiq/github-app/oauth — the user-OAuth half of the shared GitHub plumbing:
 * authorize URL, code exchange, grant refresh, and the /user identity fetch.
 * Both backends run the SAME wire dance (same params, same accept headers);
 * only what they keep differs — the live-host stores the full TokenGrant for
 * its sessions, the control plane uses the token once (identity + tenant
 * discovery, ADR 0001) and adapts to `.accessToken` in its adapter.
 *
 * Zero third-party deps (global fetch only). Base URLs are parameters so the
 * same code serves github.com, GitHub Enterprise, and the offline test stub.
 */
import type { GitHubApi } from "./index.ts";

/** OAuth client credentials + the WEB base URL (authorize/token endpoints). */
export interface OAuthApp {
  clientId: string;
  clientSecret: string;
  /** web base, e.g. https://github.com (NOT the REST apiUrl) */
  baseUrl: string;
}

/**
 * Result of an OAuth code exchange (or refresh). GitHub Apps default to
 * expiring 8h user tokens with a refresh token; classic OAuth apps return a
 * non-expiring token (refreshToken/expiresAt stay undefined).
 */
export interface TokenGrant {
  accessToken: string;
  refreshToken?: string;
  /** epoch ms; undefined = the token does not expire */
  expiresAt?: number;
}

/** The authenticated user's identity, normalized (GET /user). */
export interface OAuthUser {
  login: string;
  name: string;
  avatarUrl: string | null;
  provider: string;
}

/**
 * Full authorize URL the browser is redirected to. GitHub-App-mode callers
 * pass NO scope — permissions come from the app itself (fine-grained,
 * installation-bound); classic OAuth callers pass e.g. `{ scope: "repo" }`.
 */
export function authorizeUrl(app: OAuthApp, redirectUri: string, state: string, opts: { scope?: string } = {}): string {
  const params = new URLSearchParams({ client_id: app.clientId, redirect_uri: redirectUri, state });
  if (opts.scope) params.set("scope", opts.scope);
  return `${app.baseUrl}/login/oauth/authorize?${params}`;
}

/** POST /login/oauth/access_token with a JSON body; normalizes to TokenGrant. */
async function tokenRequest(app: OAuthApp, body: Record<string, string>): Promise<TokenGrant> {
  const res = await fetch(`${app.baseUrl}/login/oauth/access_token`, {
    method: "POST",
    headers: { accept: "application/json", "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const data = (await res.json()) as {
    access_token?: string;
    refresh_token?: string;
    expires_in?: number;
    error_description?: string;
  };
  if (!res.ok || !data.access_token) {
    throw new Error(`GitHub token exchange failed: ${data.error_description ?? res.status}`);
  }
  return {
    accessToken: data.access_token,
    refreshToken: data.refresh_token,
    expiresAt: data.expires_in ? Date.now() + data.expires_in * 1000 : undefined,
  };
}

/** Exchange the OAuth callback code for the user's token grant. */
export async function exchangeCode(app: OAuthApp, code: string, redirectUri: string): Promise<TokenGrant> {
  return tokenRequest(app, {
    client_id: app.clientId,
    client_secret: app.clientSecret,
    code,
    redirect_uri: redirectUri,
  });
}

/** Refresh an expiring grant (GitHub App user tokens expire after 8h). */
export async function refreshGrant(app: OAuthApp, refreshToken: string): Promise<TokenGrant> {
  return tokenRequest(app, {
    client_id: app.clientId,
    client_secret: app.clientSecret,
    grant_type: "refresh_token",
    refresh_token: refreshToken,
  });
}

/** Fetch the authenticated user's identity with their token (GET /user). */
export async function fetchUser(api: GitHubApi, token: string): Promise<OAuthUser> {
  const res = await fetch(`${api.apiUrl}/user`, {
    headers: {
      accept: "application/vnd.github+json",
      authorization: `Bearer ${token}`,
      "user-agent": api.userAgent,
    },
  });
  if (!res.ok) throw new Error(`GitHub /user failed: ${res.status}`);
  const u = (await res.json()) as { login: string; name?: string; avatar_url?: string };
  return { login: u.login, name: u.name ?? u.login, avatarUrl: u.avatar_url ?? null, provider: "github" };
}
