/**
 * OIDC verifier (src/auth/oidc.ts) against a REAL JWKS round-trip: a local
 * keypair, a throwaway HTTP server serving its JWKS, jose's remote key set.
 *
 * The heart of it: FAIL CLOSED on the login claim. `preferred_username`/`sub`
 * are user-editable in many IdPs — a fallback would let anyone who can rename
 * themselves at the IdP authorize as an arbitrary GitHub identity.
 */
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { after, before, test } from "node:test";

import { AppError } from "@bpmiq/http-kit";
import { exportJWK, generateKeyPair, SignJWT } from "jose";

import { expandAudienceTwins, makeOidcVerifier, type OidcVerify } from "../src/auth/oidc.ts";

const ISSUER = "https://idp.example";
const AUDIENCE = "https://live.example";

let jwks: Server;
let verify: OidcVerify;
let privateKey: CryptoKey;
let rogueKey: CryptoKey;

before(async () => {
  const pair = await generateKeyPair("RS256");
  const rogue = await generateKeyPair("RS256");
  privateKey = pair.privateKey as CryptoKey;
  rogueKey = rogue.privateKey as CryptoKey;
  const jwk = { ...(await exportJWK(pair.publicKey)), kid: "test-key", alg: "RS256", use: "sig" };
  jwks = createServer((_req, res) => {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ keys: [jwk] }));
  });
  await new Promise<void>((resolve) => jwks.listen(0, "127.0.0.1", resolve));
  const port = (jwks.address() as { port: number }).port;
  verify = makeOidcVerifier({
    issuer: ISSUER,
    jwksUrl: `http://127.0.0.1:${port}/jwks`,
    audience: AUDIENCE,
    loginClaim: "github_login",
  });
});
after(() => jwks.close());

function token(over: {
  claims?: Record<string, unknown>;
  issuer?: string;
  audience?: string;
  expiresIn?: string;
  key?: CryptoKey;
}): Promise<string> {
  return new SignJWT({ github_login: "petra", name: "Petra", ...over.claims })
    .setProtectedHeader({ alg: "RS256", kid: "test-key" })
    .setIssuer(over.issuer ?? ISSUER)
    .setAudience(over.audience ?? AUDIENCE)
    .setSubject("user-1")
    .setIssuedAt()
    .setExpirationTime(over.expiresIn ?? "5m")
    .sign(over.key ?? privateKey);
}

const codeOf = async (p: Promise<unknown>): Promise<string> => {
  try {
    await p;
    return "(no error)";
  } catch (e) {
    assert.ok(e instanceof AppError, `expected AppError, got ${String(e)}`);
    assert.equal((e as AppError).status, 401);
    return (e as AppError).code;
  }
};

test("a valid audience-bound token yields the identity", async () => {
  const id = await verify(await token({}));
  assert.deepEqual(id, { login: "petra", name: "Petra", sub: "user-1" });
});

test("expired / wrong audience / wrong issuer / bad signature → distinct 401 codes", async () => {
  assert.equal(await codeOf(verify(await token({ expiresIn: "-1m" }))), "auth/token-expired");
  assert.equal(await codeOf(verify(await token({ audience: "https://other.example" }))), "auth/wrong-audience");
  assert.equal(await codeOf(verify(await token({ issuer: "https://rogue.example" }))), "auth/wrong-issuer");
  assert.equal(await codeOf(verify(await token({ key: rogueKey }))), "auth/invalid-token");
  assert.equal(await codeOf(verify("not-a-jwt")), "auth/invalid-token");
});

test("expandAudienceTwins: each audience gains its trailing-slash twin, exact literals only", () => {
  assert.deepEqual(expandAudienceTwins("https://h").sort(), ["https://h", "https://h/"]);
  assert.deepEqual(expandAudienceTwins("https://h/mcp").sort(), ["https://h/mcp", "https://h/mcp/"]);
  // a list is de-duplicated; no prefix widening ("https://h" never admits "https://h/mcp")
  assert.deepEqual(expandAudienceTwins(["https://h", "https://h/"]).sort(), ["https://h", "https://h/"]);
});

test("audience list + trailing-slash twin: the SDK's `${origin}/` aud matches a bare-origin config", async () => {
  const port = (jwks.address() as { port: number }).port;
  const multi = makeOidcVerifier({
    issuer: ISSUER,
    jwksUrl: `http://127.0.0.1:${port}/jwks`,
    audience: [AUDIENCE, `${AUDIENCE}/mcp`],
    loginClaim: "github_login",
  });
  // bare origin configured, token carries the SDK-normalised trailing slash → accepted
  assert.equal((await multi(await token({ audience: `${AUDIENCE}/` }))).login, "petra");
  // the second resource identifier is accepted too
  assert.equal((await multi(await token({ audience: `${AUDIENCE}/mcp` }))).login, "petra");
  // an unrelated audience is still rejected — no prefix/normalising escape
  assert.equal(await codeOf(multi(await token({ audience: "https://evil.example" }))), "auth/wrong-audience");
});

test("FAIL CLOSED: preferred_username without the login claim is refused, never used", async () => {
  const t = await new SignJWT({ preferred_username: "victim-gh-login", name: "Mallory" })
    .setProtectedHeader({ alg: "RS256", kid: "test-key" })
    .setIssuer(ISSUER)
    .setAudience(AUDIENCE)
    .setSubject("user-2")
    .setIssuedAt()
    .setExpirationTime("5m")
    .sign(privateKey);
  assert.equal(await codeOf(verify(t)), "auth/missing-claim");
});

test("a custom login claim is honored; name falls back to the login", async () => {
  const port = (jwks.address() as { port: number }).port;
  const custom = makeOidcVerifier({
    issuer: ISSUER,
    jwksUrl: `http://127.0.0.1:${port}/jwks`,
    audience: AUDIENCE,
    loginClaim: "gitlab_username",
  });
  const t = await new SignJWT({ gitlab_username: "petra-gl" })
    .setProtectedHeader({ alg: "RS256", kid: "test-key" })
    .setIssuer(ISSUER)
    .setAudience(AUDIENCE)
    .setSubject("user-3")
    .setIssuedAt()
    .setExpirationTime("5m")
    .sign(privateKey);
  const id = await custom(t);
  assert.equal(id.login, "petra-gl");
  assert.equal(id.name, "petra-gl");
});

test("cell mode: a required claim gates the tenant — wrong installation_id → 401, matching → ok", async () => {
  const port = (jwks.address() as { port: number }).port;
  const cell = makeOidcVerifier({
    issuer: ISSUER,
    jwksUrl: `http://127.0.0.1:${port}/jwks`,
    audience: AUDIENCE,
    loginClaim: "github_login",
    requiredClaims: { installation_id: "145185795" },
  });
  // a token minted for another tenant (shared audience) is rejected as wrong-tenant
  assert.equal(await codeOf(cell(await token({ claims: { installation_id: "999" } }))), "auth/wrong-tenant");
  // a token with no installation_id at all is rejected (absent !== expected)
  assert.equal(await codeOf(cell(await token({}))), "auth/wrong-tenant");
  // the matching tenant passes and still yields the identity
  const id = await cell(await token({ claims: { installation_id: "145185795" } }));
  assert.equal(id.login, "petra");
});
