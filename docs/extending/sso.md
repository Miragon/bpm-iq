# Extending bpmiq: SSO / identity providers

**Browser SSO ships built-in**: any OIDC-conformant IdP (Keycloak, Entra ID,
WorkOS, …) can BE the web login — set `LIVE_OIDC_CLIENT_ID` next to the
resource-server config and the login button runs the IdP's hosted flow
(authorization code + PKCE, `src/auth/oidc-login.ts`; see
[on-prem/configuration.md](../on-prem/configuration.md)). This page describes
the seam it was built against ([ADR 0004](../adr/0004-open-source-split.md)) —
still the guide for anything beyond OIDC (SAML, a vendor-specific handshake).

## The principle: identity is not authorization

From the live-host README (WorkOS section):

> WorkOS AuthKit can sit in front for enterprise SSO (_who you are_), but repository
> authorization always requires the git provider's own grant (_what you may
> release_) — that grant is what the `GitProvider` interface models, and it is the
> actual entry ticket. Wiring WorkOS in means: authenticate the person via WorkOS
> first, then link the git-provider grant to that identity. Clean seam: session
> issuance (`SessionStore`, `src/adapters/sqlite/sessions.ts`) is independent of the
> provider handshake.

So: an OIDC/SAML/WorkOS layer answers **who you are**; the git provider's
per-(user,repo) grant answers **what you may release** — and stays the entry ticket
regardless of SSO. SSO never replaces `checkUserPermission`, it
only changes how a session comes into existence. Merge rights stay at the provider
(CODEOWNERS/branch protection) either way.

## The seam in code: session issuance is provider-independent

`SessionStore` (`apps/live-host/src/adapters/sqlite/sessions.ts`) mints sessions
from an identity and nothing else — there is no grant to attach
([ADR 0007](../adr/0007-idp-only-login-and-no-auth-mode.md)):

```ts
create(user: GitUser): Session
```

Two production paths in `apps/live-host/src/http/api.ts` prove the independence:

- The **OIDC browser login** (`/auth/oidc/callback`) mints a session from a verified
  IdP access token: `opts.sessions.create(identity)` — the session id (an httpOnly
  cookie / the websocket token) is the only credential clients ever hold.
- A **bearer JWT** on `/mcp` or the REST routes yields a synthetic, never-persisted
  session of the same shape (`sessionOf`).

Both are identity-only: zero stored user token; authorization runs app-side via the
connection source's `checkUserPermission` (installation token, ADR 0001), and releases
are bot-authored with human attribution. An identity-only session is therefore the
ONLY session there is — exactly what any SSO login produces.

## Where an SSO contribution lands

`apps/live-host/src/auth/` is the landing zone for identity-provider modules
(OIDC/SAML/WorkOS) — with two residents: `oidc.ts`, bearer-JWT resource-server
verification of audience-bound IdP tokens, used by `/mcp` and the REST content
routes ([ADR 0005](../adr/0005-in-process-mcp-and-oidc-resource-server.md)),
and `oidc-login.ts`, the interactive authorize-redirect browser login (code +
PKCE) whose access token is validated by exactly that verifier. Further flows
(SAML, vendor handshakes) land right beside them. Git-provider authorization
does NOT belong there; that lives in `ports/` + `adapters/<vendor>/`
(see [connectors.md](connectors.md)). As everywhere else, `server.ts` stays the
only place reading env and wiring the module in (ADR 0003, `pnpm arch`-enforced).

## The flow, in five steps

1. **Authenticate the person first** — a new `src/auth/<idp>/` module implements
   the IdP handshake (authorize redirect + callback route, mirroring the
   `/auth/:provider` pattern incl. the browser-bound state cookie). _Real today
   for OIDC:_ both halves exist — `src/auth/oidc.ts` verifies audience-bound
   bearer JWTs (`/mcp`, headless REST), and `src/auth/oidc-login.ts` runs the
   interactive code+PKCE browser login whose access token lands in exactly that
   verifier (`/auth/oidc` + `/auth/oidc/callback` in `http/api.ts`).
2. **Mint a session from the identity** — `sessions.create(identity)`, no grant;
   the same identity-only shape the OIDC login uses — and exactly the
   identity-only principal a verified OIDC JWT yields today.
3. **The session authenticates, nothing authorizes yet** — `/api/repos` shows no
   writable repo until a git-provider authorization can be resolved for this
   identity.
4. **Map the identity to the git-provider login** — the IdP profile carries the
   provider username, and the app-side `checkUserPermission` path answers without any
   user token (ADR 0001). This is the only path: user grants are not stored
   ([ADR 0007](../adr/0007-idp-only-login-and-no-auth-mode.md)). _Concretely:_
   `oidc.ts` takes the verified GitHub login from the token's login claim
   (`LIVE_OIDC_LOGIN_CLAIM`, default `github_login`; a token without it is refused) —
   the account-linking consequence is recorded in
   [ADR 0005](../adr/0005-in-process-mcp-and-oidc-resource-server.md).
5. **Per-(user,repo) authorization runs unchanged** — `AccessCache` gates every
   room join, API call and release exactly as today. SSO changed who logs in,
   never what they may release.
