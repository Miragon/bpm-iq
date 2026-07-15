/**
 * @bpmiq/github-app — the GitHub App primitives shared by the control plane
 * (the ONLY holder of the app private key, ADR 0002) and a standalone / local
 * live-host: the RS256 app JWT, private-key loading, and the REST plumbing
 * (app-authenticated requests, installation-token minting, Link-header
 * pagination), pinned here so the two sides can't drift (they had already: the
 * .pem auto-detect existed on only one). Zero third-party deps (node:crypto +
 * node:fs). In cell mode a cell never holds the key — it uses
 * @bpmiq/cell-protocol handoffs instead.
 *
 * Each app keeps a thin adapter that pins ITS user-agent (GitHubApi.userAgent
 * is a parameter here — "bpm-control-plane" vs "bpm-live-host") and delegates
 * the wire work to this package. The user-OAuth half lives in ./oauth.ts.
 */
import { createSign } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";

/** the minimum needed to act AS THE APP */
export interface AppKey {
  appId: string;
  /** PEM (PKCS#1 or PKCS#8) */
  privateKey: string;
}

const b64url = (data: string | Buffer): string => Buffer.from(data).toString("base64url");

/**
 * RS256 app JWT (iss = app id, ~9 min lifetime). `iat` is backdated 60s to
 * tolerate clock drift (GitHub's own recommendation). `now` (epoch ms) is
 * injectable so the exact token is reproducible in tests.
 */
export function appJwt(key: AppKey, now: number = Date.now()): string {
  const sec = Math.floor(now / 1000);
  const header = b64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const payload = b64url(JSON.stringify({ iat: sec - 60, exp: sec + 540, iss: key.appId }));
  const signer = createSign("RSA-SHA256");
  signer.update(`${header}.${payload}`);
  return `${header}.${payload}.${signer.sign(key.privateKey).toString("base64url")}`;
}

/**
 * Resolve the app private key from the environment, in precedence order:
 *   1. GITHUB_APP_PRIVATE_KEY      raw PEM (a double-quoted multi-line .env value)
 *   2. GITHUB_APP_PRIVATE_KEY_FILE explicit .pem path (deploys)
 *   3. GITHUB_APP_PRIVATE_KEY_B64  base64 one-liner (env-only deploys)
 *   4. the first *.pem in `pemDir`  local-dev convenience (only if pemDir is given)
 * Returns undefined when nothing is configured (cell mode carries no key).
 */
export function loadPrivateKey(
  env: Record<string, string | undefined> = process.env,
  opts: { pemDir?: string; log?: (msg: string) => void } = {},
): string | undefined {
  const raw = env.GITHUB_APP_PRIVATE_KEY;
  if (raw?.includes("PRIVATE KEY")) return raw;
  const file = env.GITHUB_APP_PRIVATE_KEY_FILE;
  if (file) return readFileSync(resolve(file), "utf8");
  const b64 = env.GITHUB_APP_PRIVATE_KEY_B64;
  if (b64) return Buffer.from(b64, "base64").toString("utf8");
  if (opts.pemDir) {
    const pem = readdirSync(opts.pemDir)
      .filter((f) => f.endsWith(".pem"))
      .sort()[0];
    if (pem) {
      opts.log?.(`app private key: auto-detected ${pem} in ${opts.pemDir}`);
      return readFileSync(join(opts.pemDir, pem), "utf8");
    }
  }
  return undefined;
}

// ── REST plumbing (shared wire, per-app user-agent) ─────────────────────────

/** Where to reach the GitHub REST API — and as whom (per-app user-agent). */
export interface GitHubApi {
  /** REST base, e.g. https://api.github.com */
  apiUrl: string;
  /** the calling app's user-agent, e.g. "bpm-control-plane" / "bpm-live-host" */
  userAgent: string;
}

/**
 * App-authenticated REST request: signs a FRESH app JWT per call and attaches
 * the standard GitHub media type + the caller's user-agent. Headers passed via
 * `init` win over the defaults (same merge order both apps used).
 */
export async function appRest(key: AppKey, api: GitHubApi, path: string, init: RequestInit = {}): Promise<Response> {
  return fetch(`${api.apiUrl}${path}`, {
    ...init,
    headers: {
      accept: "application/vnd.github+json",
      authorization: `Bearer ${appJwt(key)}`,
      "user-agent": api.userAgent,
      ...(init.headers ?? {}),
    },
  });
}

export interface MintedToken {
  token: string;
  /** epoch ms (GitHub's expires_at ISO string, parsed) */
  expiresAt: number;
}

/** Mint a 1h installation token for ONE installation (POST …/access_tokens). */
export async function mintInstallationToken(key: AppKey, api: GitHubApi, installationId: number): Promise<MintedToken> {
  const res = await appRest(key, api, `/app/installations/${installationId}/access_tokens`, { method: "POST" });
  if (!res.ok) throw new Error(`installation token for ${installationId} failed: ${res.status} ${await res.text()}`);
  const body = (await res.json()) as { token: string; expires_at: string };
  return { token: body.token, expiresAt: Date.parse(body.expires_at) };
}

/** How paginate authenticates: a (user/installation) token OR the app JWT. */
export type PaginateAuth = { token: string } | { key: AppKey };

/**
 * Follow GitHub's Link: rel="next" pagination from `firstPath`, concatenating
 * the pages. Unwraps envelope responses ({repositories: […]}, e.g.
 * /installation/repositories) as well as bare arrays (e.g. /app/installations).
 * App-JWT auth re-signs a fresh JWT per page (long enumerations outlive a JWT).
 */
export async function paginate(api: GitHubApi, firstPath: string, auth: PaginateAuth): Promise<unknown[]> {
  const out: unknown[] = [];
  let url: string | null = `${api.apiUrl}${firstPath}`;
  while (url) {
    const res: Response = await fetch(url, {
      headers: {
        accept: "application/vnd.github+json",
        authorization: `Bearer ${"token" in auth ? auth.token : appJwt(auth.key)}`,
        "user-agent": api.userAgent,
      },
    });
    if (!res.ok) throw new Error(`${firstPath} → ${res.status} ${await res.text()}`);
    const body = await res.json();
    // e.g. /installation/repositories wraps the array; /app/installations is bare
    out.push(...(Array.isArray(body) ? body : (body as { repositories: unknown[] }).repositories));
    const next = res.headers.get("link")?.match(/<([^>]+)>;\s*rel="next"/);
    url = next ? (next[1] ?? null) : null;
  }
  return out;
}
