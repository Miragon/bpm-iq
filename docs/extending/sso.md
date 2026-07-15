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

`apps/live-host/src/auth/` is the reserved landing zone for identity-provider
modules (OIDC/SAML/WorkOS) — today empty by design (see its README). Git-provider
authorization does NOT belong there; that lives in `ports/` + `adapters/<vendor>/`
(see [connectors.md](connectors.md)). As everywhere else, `server.ts` stays the
only place reading env and wiring the module in (ADR 0003, `pnpm arch`-enforced).

## The flow, in five steps

1. **Authenticate the person first** — a new `src/auth/<idp>/` module implements
   the IdP handshake (authorize redirect + callback route, mirroring the
   `/auth/:provider` pattern incl. the browser-bound state cookie).
2. **Mint a session from the identity** — `sessions.create(identity)`, no grant;
   the same identity-only shape the handoff login uses.
3. **The session authenticates, nothing authorizes yet** — `/api/repos` shows no
   writable repo until a git-provider authorization can be resolved for this
   identity.
4. **Link the git-provider grant to that identity** — either run the existing
   `GitProvider` OAuth from within the session and attach the grant
   (`SessionStore.updateGrant`), or map the IdP profile to a provider username and
   let the app-side `checkUserPermission` path answer without any user token
   (ADR 0001).
5. **Per-(user,repo) authorization runs unchanged** — `AccessCache` gates every
   room join, API call and release exactly as today. SSO changed who logs in,
   never what they may release.
