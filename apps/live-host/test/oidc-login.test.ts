/**
 * The browser OIDC login (auth/oidc-login.ts + the /auth/oidc routes) over real
 * HTTP against a stub IdP: discovery, the PKCE authorize redirect, the code
 * exchange, and the heart of it — the access token is validated by the SAME
 * resource-server verifier as MCP bearers (fail-closed login claim, and in cell
 * mode the tenant gate, which routes a cross-tenant login back to the platform).
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { after, before, test } from "node:test";

import { exportJWK, generateKeyPair, SignJWT } from "jose";

import { SessionStore } from "../src/adapters/sqlite/sessions.ts";
import { makeOidcVerifier } from "../src/auth/oidc.ts";
import { makeOidcLogin } from "../src/auth/oidc-login.ts";
import { type ApiOptions, startApi } from "../src/http/api.ts";
import type { GitProvider } from "../src/ports/git-provider.ts";

const AUDIENCE = "https://live.example";
const CP_URL = "https://cp.example";

let idp: Server; // discovery + JWKS + token endpoint in one
let idpBase = "";
let privateKey: CryptoKey;
let discoveryHits = 0;
/** every token-endpoint request body, latest last */
const tokenRequests: URLSearchParams[] = [];
/** per-code claim overrides the stub token endpoint signs into the access token */
const CODE_CLAIMS: Record<string, Record<string, unknown> | "reject"> = {
  good: { github_login: "petra", name: "Petra" },
  "no-claim": { name: "Mallory" },
  "wrong-tenant": { github_login: "petra", installation_id: "999" },
  "right-tenant": { github_login: "petra", installation_id: "42" },
  bad: "reject",
};

const servers: Server[] = [];
after(async () => {
  for (const s of servers) await new Promise((r) => s.close(r));
});

before(async () => {
  const pair = await generateKeyPair("RS256");
  privateKey = pair.privateKey as CryptoKey;
  const jwk = { ...(await exportJWK(pair.publicKey)), kid: "login-key", alg: "RS256", use: "sig" };

  idp = createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", idpBase);
    const json = (status: number, body: unknown): void => {
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify(body));
    };
    if (url.pathname === "/.well-known/openid-configuration") {
      discoveryHits++;
      return json(200, {
        issuer: idpBase,
        authorization_endpoint: `${idpBase}/authorize`,
        token_endpoint: `${idpBase}/token`,
        jwks_uri: `${idpBase}/jwks`,
      });
    }
    if (url.pathname === "/jwks") return json(200, { keys: [jwk] });
    if (url.pathname === "/token" && req.method === "POST") {
      const chunks: Buffer[] = [];
      for await (const c of req) chunks.push(c as Buffer);
      const form = new URLSearchParams(Buffer.concat(chunks).toString());
      tokenRequests.push(form);
      const claims = CODE_CLAIMS[form.get("code") ?? ""];
      if (!claims || claims === "reject") return json(400, { error: "invalid_grant" });
      const token = await new SignJWT(claims)
        .setProtectedHeader({ alg: "RS256", kid: "login-key" })
        .setIssuer(idpBase)
        .setAudience(AUDIENCE)
        .setSubject("user-1")
        .setIssuedAt()
        .setExpirationTime("5m")
        .sign(privateKey);
      return json(200, { access_token: token, token_type: "Bearer", expires_in: 300 });
    }
    return json(404, { error: "no route" });
  });
  servers.push(idp);
  await new Promise<void>((r) => idp.listen(0, "127.0.0.1", r));
  idpBase = `http://127.0.0.1:${(idp.address() as { port: number }).port}`;
});

/** boot startApi with the OIDC login against the stub IdP; cellMode adds the tenant gate */
function boot(cellMode: boolean): { base: string; sessions: SessionStore } {
  const sessions = new SessionStore(new DatabaseSync(":memory:"));
  const opts: ApiOptions = {
    webDist: mkdtempSync(join(tmpdir(), "bpm-webdist-")),
    publicUrl: "http://live.test",
    providers: new Map(),
    github: {} as GitProvider,
    sessions,
    registry: { get: () => undefined, list: () => [] } as unknown as ApiOptions["registry"],
    workspaces: {} as ApiOptions["workspaces"],
    access: { canWrite: async () => true } as unknown as ApiOptions["access"],
    liveDocs: () => [],
    dropLineage: () => {},
    openDoc: () => Promise.reject(new Error("not used")),
    maxDocBytes: 8_000_000,
    controlPlaneUrl: cellMode ? CP_URL : undefined,
    tenantInstallationId: cellMode ? 42 : undefined,
    oidc: {
      issuer: idpBase,
      verify: makeOidcVerifier({
        issuer: idpBase,
        jwksUrl: `${idpBase}/jwks`,
        audience: AUDIENCE,
        loginClaim: "github_login",
        requiredClaims: cellMode ? { installation_id: "42" } : undefined,
      }),
    },
    oidcLogin: makeOidcLogin({ issuer: idpBase, clientId: "client-1" }),
  };
  const httpServer = startApi(0, opts);
  servers.push(httpServer);
  const base = (): string => `http://127.0.0.1:${(httpServer.address() as { port: number }).port}`;
  return {
    get base() {
      return base();
    },
    sessions,
  } as { base: string; sessions: SessionStore };
}

const cookieOf = (res: Response, name: string): string | undefined =>
  res.headers
    .getSetCookie()
    .find((c) => c.startsWith(`${name}=`))
    ?.split(";")[0]
    ?.slice(name.length + 1);

/** run /auth/oidc and hand back what the browser would carry to the callback */
async function startLogin(base: string): Promise<{ location: URL; state: string; nonce: string; verifier: string }> {
  const res = await fetch(`${base}/auth/oidc`, { redirect: "manual" });
  assert.equal(res.status, 302);
  const location = new URL(res.headers.get("location")!);
  return {
    location,
    state: location.searchParams.get("state")!,
    nonce: cookieOf(res, "bpm_live_oauth")!,
    verifier: cookieOf(res, "bpm_live_pkce")!,
  };
}

const callback = (base: string, query: string, cookies: string): Promise<Response> =>
  fetch(`${base}/auth/oidc/callback?${query}`, { redirect: "manual", headers: { cookie: cookies } });

test("/api/config advertises the SSO login ahead of the git providers", async () => {
  const { base } = boot(false);
  const cfg = (await (await fetch(`${base}/api/config`)).json()) as {
    providers: Array<{ id: string; label: string }>;
    mcpUrl: string;
  };
  assert.deepEqual(cfg.providers, [{ id: "oidc", label: "SSO" }]);
  // the copy-to-clipboard URL in the web overview — publicUrl-based, not Host-based
  assert.equal(cfg.mcpUrl, "http://live.test/mcp");
});

test("/auth/oidc: discovery-resolved authorize redirect with browser-bound state + S256 PKCE", async () => {
  const { base } = boot(false);
  const { location, state, nonce, verifier } = await startLogin(base);
  assert.equal(location.origin + location.pathname, `${idpBase}/authorize`);
  assert.equal(location.searchParams.get("response_type"), "code");
  assert.equal(location.searchParams.get("client_id"), "client-1");
  assert.equal(location.searchParams.get("redirect_uri"), "http://live.test/auth/oidc/callback");
  assert.equal(location.searchParams.get("scope"), "openid profile email");
  assert.equal(location.searchParams.get("code_challenge_method"), "S256");
  assert.ok(state && nonce && verifier, "state + nonce cookie + PKCE cookie all issued");
  assert.equal(
    location.searchParams.get("code_challenge"),
    createHash("sha256").update(verifier).digest("base64url"),
    "challenge is S256 of the cookie-bound verifier",
  );
});

test("full login: code exchange (PKCE verifier sent) → verified token → identity-only session", async () => {
  const { base, sessions } = boot(false);
  const { state, nonce, verifier } = await startLogin(base);
  const res = await callback(
    base,
    `code=good&state=${encodeURIComponent(state)}`,
    `bpm_live_oauth=${nonce}; bpm_live_pkce=${verifier}`,
  );
  assert.equal(res.status, 302);
  assert.equal(res.headers.get("location"), "/");

  const exchange = tokenRequests.at(-1)!;
  assert.equal(exchange.get("grant_type"), "authorization_code");
  assert.equal(exchange.get("client_id"), "client-1");
  assert.equal(exchange.get("redirect_uri"), "http://live.test/auth/oidc/callback");
  assert.equal(exchange.get("code_verifier"), verifier, "the browser-bound PKCE verifier reaches the IdP");
  assert.equal(exchange.get("client_secret"), null, "public client sends no secret");

  const sid = cookieOf(res, "bpm_live_sid")!;
  const me = await fetch(`${base}/api/me`, { headers: { cookie: `bpm_live_sid=${sid}` } });
  assert.equal(me.status, 200);
  const body = (await me.json()) as { user: { login: string; provider: string } };
  assert.equal(body.user.login, "petra");
  assert.equal(body.user.provider, "oidc");
  // zero stored user token (ADR 0001): the session is identity-only
  assert.equal(sessions.get(sid)?.providerToken, "");
});

test("state without its browser cookie, missing PKCE cookie, IdP error — all refused", async () => {
  const { base } = boot(false);
  const { state, nonce } = await startLogin(base);
  // valid state, no cookies → login-CSRF guard
  assert.equal((await callback(base, `code=good&state=${encodeURIComponent(state)}`, "")).status, 400);
  // bound state but the PKCE verifier is gone → no exchange possible
  const noPkce = await callback(base, `code=good&state=${encodeURIComponent(state)}`, `bpm_live_oauth=${nonce}`);
  assert.equal(noPkce.status, 400);
  // the IdP refused (user cancelled, policy) → 401, flow cookies cleared
  const s2 = await startLogin(base);
  const denied = await callback(
    base,
    `error=access_denied&state=${encodeURIComponent(s2.state)}`,
    `bpm_live_oauth=${s2.nonce}; bpm_live_pkce=${s2.verifier}`,
  );
  assert.equal(denied.status, 401);
});

test("a used/expired code and a token without the login claim both fail closed", async () => {
  const { base } = boot(false);
  const s1 = await startLogin(base);
  const bad = await callback(
    base,
    `code=bad&state=${encodeURIComponent(s1.state)}`,
    `bpm_live_oauth=${s1.nonce}; bpm_live_pkce=${s1.verifier}`,
  );
  assert.equal(bad.status, 401, "IdP rejects the code → user-facing 401, not a 500");

  const s2 = await startLogin(base);
  const noClaim = await callback(
    base,
    `code=no-claim&state=${encodeURIComponent(s2.state)}`,
    `bpm_live_oauth=${s2.nonce}; bpm_live_pkce=${s2.verifier}`,
  );
  assert.equal(noClaim.status, 401, "no github_login claim → refused (no fallback, ever)");
});

test("cell mode: the tenant gate routes a cross-tenant login back to the platform", async () => {
  const { base } = boot(true); // requiredClaims installation_id=42 + controlPlaneUrl
  const s1 = await startLogin(base);
  const wrong = await callback(
    base,
    `code=wrong-tenant&state=${encodeURIComponent(s1.state)}`,
    `bpm_live_oauth=${s1.nonce}; bpm_live_pkce=${s1.verifier}`,
  );
  assert.equal(wrong.status, 302, "not an error page — a routing problem");
  assert.equal(wrong.headers.get("location"), `${CP_URL}/login?org=42`, "asks the platform to rescope to THIS tenant");

  const s2 = await startLogin(base);
  const right = await callback(
    base,
    `code=right-tenant&state=${encodeURIComponent(s2.state)}`,
    `bpm_live_oauth=${s2.nonce}; bpm_live_pkce=${s2.verifier}`,
  );
  assert.equal(right.status, 302);
  assert.equal(right.headers.get("location"), "/", "the matching tenant logs in normally");
});

test("discovery is fetched lazily once and never re-fetched; explicit endpoints skip it", async () => {
  const before = discoveryHits;
  const login = makeOidcLogin({ issuer: idpBase, clientId: "c" });
  await login.authorizeUrl("http://x/cb", "s", "ch");
  await login.authorizeUrl("http://x/cb", "s2", "ch2");
  await login.exchangeCode("good", "http://x/cb", "v");
  assert.equal(discoveryHits, before + 1, "one discovery fetch for the instance");

  const explicit = makeOidcLogin({
    issuer: "https://unreachable.example",
    clientId: "c",
    authorizeUrl: `${idpBase}/authorize`,
    tokenUrl: `${idpBase}/token`,
  });
  const url = await explicit.authorizeUrl("http://x/cb", "s", "ch");
  assert.ok(url.startsWith(`${idpBase}/authorize`));
  assert.equal(discoveryHits, before + 1, "explicit endpoints → no discovery fetch");
});

test("a confidential client sends its secret in the token request", async () => {
  const login = makeOidcLogin({ issuer: idpBase, clientId: "c", clientSecret: "shhh" });
  await login.exchangeCode("good", "http://x/cb", "v");
  assert.equal(tokenRequests.at(-1)!.get("client_secret"), "shhh");
  assert.equal(tokenRequests.at(-1)!.get("code_verifier"), "v", "PKCE stays on for confidential clients too");
});
