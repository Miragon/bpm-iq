# Extending bpmiq: SSO / identity providers

SSO is a roadmap item meant to be contributed against an existing seam
([ADR 0004](../adr/0004-open-source-split.md)). This page describes that seam.

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
regardless of SSO. SSO never replaces `checkRepoAccess`/`checkUserPermission`, it
only changes how a session comes into existence. Merge rights stay at the provider
(CODEOWNERS/branch protection) either way.

## The seam in code: session issuance is provider-independent

`SessionStore` (`apps/live-host/src/adapters/sqlite/sessions.ts`) mints sessions
from an identity — the grant is **optional**:

```ts
create(user: GitUser, grant?: TokenGrant): Session
```

Two production paths in `apps/live-host/src/http/api.ts` prove the independence:

- The **OAuth callback** (`/auth/:provider/callback`) exchanges the code, fetches
  the user, then mints: `opts.sessions.create(user, grant)` — the session id (an
  httpOnly cookie / the websocket token) is the only credential clients ever hold.
- The **cell handoff login** (`/auth/handoff`, ADR 0002) mints a session from a
  signed identity token with **no grant at all**: `opts.sessions.create(identity)` —
  zero stored user token; authorization then runs app-side via the connection
  source's `checkUserPermission` (installation token, ADR 0001), and releases are
  bot-authored with human attribution.

An identity-only session is therefore already a supported, tested state — exactly
what an SSO login produces.

## Where an SSO contribution lands

`apps/live-host/src/auth/` is the landing zone for identity-provider modules
(OIDC/SAML/WorkOS) — and has its first resident: `oidc.ts`, bearer-JWT
resource-server verification of audience-bound IdP tokens, used by `/mcp` and the
REST content routes
([ADR 0005](../adr/0005-in-process-mcp-and-oidc-resource-server.md)). Interactive
authorize-redirect login flows land right beside it. Git-provider authorization
does NOT belong there; that lives in `ports/` + `adapters/<vendor>/`
(see [connectors.md](connectors.md)). As everywhere else, `server.ts` stays the
only place reading env and wiring the module in (ADR 0003, `pnpm arch`-enforced).

## The flow, in five steps

1. **Authenticate the person first** — a new `src/auth/<idp>/` module implements
   the IdP handshake (authorize redirect + callback route, mirroring the
   `/auth/:provider` pattern incl. the browser-bound state cookie). _Partially
   real today:_ the token-**verification** half exists (`src/auth/oidc.ts`
   verifies audience-bound bearer JWTs for `/mcp` and headless REST); the
   interactive browser login via the IdP is the part still open.
2. **Mint a session from the identity** — `sessions.create(identity)`, no grant;
   the same identity-only shape the handoff login uses — and exactly the
   identity-only principal a verified OIDC JWT yields today.
3. **The session authenticates, nothing authorizes yet** — `/api/repos` shows no
   writable repo until a git-provider authorization can be resolved for this
   identity.
4. **Link the git-provider grant to that identity** — either run the existing
   `GitProvider` OAuth from within the session and attach the grant
   (`SessionStore.updateGrant`), or map the IdP profile to a provider username and
   let the app-side `checkUserPermission` path answer without any user token
   (ADR 0001). _The mapping path is concrete now:_ `oidc.ts` takes the verified
   GitHub login from the token's login claim (`LIVE_OIDC_LOGIN_CLAIM`, default
   `github_login`; a token without it is refused) and `checkUserPermission`
   authorizes app-side — the account-linking consequence is recorded in
   [ADR 0005](../adr/0005-in-process-mcp-and-oidc-resource-server.md).
5. **Per-(user,repo) authorization runs unchanged** — `AccessCache` gates every
   room join, API call and release exactly as today. SSO changed who logs in,
   never what they may release.
