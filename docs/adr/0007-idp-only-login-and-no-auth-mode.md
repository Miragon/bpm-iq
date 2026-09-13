# ADR 0007 — One login: the IdP everywhere, an explicit no-auth mode, GitHub OAuth login and the dev token retired

- **Status:** accepted (2026-09-12); implemented 2026-09-13 in the three stacked
  PRs of the Rollout (#175, #176, #177) — the exit criterion is met by
  `apps/live-host/test/keycloak-e2e.sh` (16/16 against the shipped realm)
- **Context:** an inventory of every credential the Live Host accepts (verified
  against `main` at c232f7c, 2026-09-12), the product decision to keep ONE
  login, and two months of operating ADR 0005's two-entrance design
- **Related:** [0001](0001-zero-stored-user-tokens.md) (zero stored user
  tokens — reaches its target state here), [0005](0005-in-process-mcp-and-oidc-resource-server.md)
  (OIDC resource server — its consequence "the web app's GitHub-OAuth login is
  untouched" is superseded), [0002](0002-multi-tenant-cell-architecture.md)
  (cells already run OIDC-only; unchanged), [0004](0004-open-source-split.md)
  (one artifact — the on-prem quickstart changes)

## Context

### What the Live Host accepts today

One funnel (`sessionOf` in `http/api.ts`, `onAuthenticate` in
`application/collab.ts`) resolves a principal from seven credentials:

| Credential                                                                 | Presented by                            | Why it exists                                                         |
| -------------------------------------------------------------------------- | --------------------------------------- | --------------------------------------------------------------------- |
| session id — cookie `bpm_live_sid`, `Authorization: Bearer <id>`, ws token | browser, VS Code, ws rooms              | the credential every login ends in; one value, three transports       |
| OIDC access token (JWT bearer)                                             | MCP clients, CI                         | ADR 0005: GitHub cannot be the authorization server for our API       |
| dev token (`LIVE_DEV_TOKEN`, default `demo` when nothing is configured)    | tests, guest-test, the VS Code default  | bootstrap shortcut; bypasses per-repo authorization                   |
| ws ticket (single-use, 60 s, one room)                                     | the MCP-App widget iframe               | the iframe holds no cookie and no JWT (ADR 0005 amendment 2026-08-04) |
| login code (single-use, 60 s, `POST /auth/exchange`)                       | editor sign-in                          | the browser callback cannot set a cookie in the editor (#170)         |
| pasted session token                                                       | VS Code against cells on an older image | deploy workaround (#173)                                              |
| `CELL_SECRET` as health bearer, webhook HMAC, token-mint credential        | control plane, GitHub                   | machine-to-machine; out of scope here                                 |

And two ways a session comes into existence, both OAuth 2 authorization-code
flows: **GitHub OAuth** (`/auth/github`, GitHub App user-to-server tokens) and
**OIDC** (`/auth/oidc`, code + PKCE against the configured IdP). The
multiplicity is not in the logins. It comes from three sources:

1. **Two identity sources → two session shapes → two authorization paths.** A
   GitHub-OAuth session stores the user's token (encrypted,
   `sessions.provider_token`) and is authorized through
   `GitProvider.checkRepoAccess` (`AccessCache` path 2); an OIDC session is
   identity-only and can only be authorized app-side (installation token,
   path 1). ADR 0001 named the token-less session as the target state two
   months ago; the GitHub login is why it was never reached — `release.ts`
   still falls back to `session.providerToken`, `access.ts` still refreshes
   user grants.
2. **Boundaries a cookie cannot cross** (iframe, editor URI scheme) produced two
   one-time-code stores of the same shape (`ws-tickets.ts`, `login-codes.ts`).
   These are transport, not authentication — they stay.
3. **Bootstrap shortcuts that stuck.** The dev token was the M0 spike's
   identity. It is still the VS Code extension's default
   (`bpmLive.token: "demo"`), the guest script's default, and the credential of
   every integration test. A token the server never verifies is not
   authentication; it is the absence of it, dressed as a bearer.

### The bare spike is a no-auth mode with a hole

With nothing configured the server already runs without authentication: the
dev token defaults to `demo` and every headless client gets all-repos access.
The web app, however, is locked out — `/api/me` answers 401 without a cookie
and the login page has no button ("This instance is not connected to GitHub
yet"). The mode exists for machines only, and it is entered _implicitly_: the
guard against "GitHub App configured, login pending, private repos exposed"
(adversarial review, `server.ts`) is needed precisely because the mode is
inferred from what is missing.

### What the IdP requirement already implies

ADR 0005 made an IdP the operating prerequisite for remote AI clients. Every
deployment that talks to an agent — the product's reason to exist — runs an
IdP already. The GitHub login therefore only serves deployments that never
connect an AI client, at the price of the second session shape, the stored
user tokens, a second OAuth client to register and rotate, and
`request_oauth_on_install` on the App manifest. The cloud dropped GitHub OAuth
at the control plane in July (cells run per-cell DCR OIDC clients); the OSS
host kept it for the zero-prerequisite quickstart.

## Decision

1. **Exactly two operating modes, selected explicitly by `LIVE_AUTH`.**
   - `LIVE_AUTH=oidc` (default): the IdP is the only login. Prerequisites
     checked at startup: `LIVE_OIDC_ISSUER`, `LIVE_OIDC_JWKS_URL`,
     `LIVE_OIDC_CLIENT_ID` (the browser login is part of the mode, not an
     option) **and a GitHub App connection** (App id + private key on-prem; the
     control plane's token mint in a cell). Per-repo authorization runs
     app-side on installation tokens (ADR 0001); without an App an
     identity-only session can write nothing, so the combination is refused at
     startup rather than running silently read-only.
   - `LIVE_AUTH=none`: no authentication. Never inferred: the server refuses to
     start in `oidc` mode without its prerequisites and names both options in
     the error. This replaces the implicit dev-token default and the guard
     around it.

2. **`none` mode is one principal, not a token.** Every request — cookie or
   not, bearer or not, any ws token — resolves to the local principal: login
   `LIVE_LOCAL_USER`, else the OS user name; provider `local`; no avatar.
   `canWrite` is true for every repository the registry knows: the static
   `GITHUB_REPO` checkout, or the App's installations when an App is configured
   (allowed — a trusted-network single-team host; releases are then
   bot-authored with the local principal as git author, so `LIVE_LOCAL_USER`
   should be the person's GitHub login). `/mcp` answers without a bearer; no
   protected-resource metadata, no `WWW-Authenticate`. `/api/config` reports
   `auth: "none" | "oidc"`; the web client never renders the login page and
   hides logout; the VS Code extension probes `/api/me` unauthenticated and
   skips sign-in when it answers. Clients keep sending the `wsToken` from
   `/api/me` unchanged — in `none` mode it is an opaque constant and the ws
   join accepts any value. Startup logs one loud line.

3. **The dev token is retired.** `LIVE_DEV_TOKEN`, `devUser`, the `demo`
   default, the `Bearer demo` headers in tests, scripts and docs (14 files),
   the extension's `bpmLive.token` setting. Everything that used it runs the
   host with `LIVE_AUTH=none`. Its semantics ("headless identity, all repos")
   ARE `none` mode's definition; keeping both would keep an unverified bearer
   as a second entrance.

4. **GitHub OAuth login is removed.** `/auth/:provider` and its callback,
   including the install-initiated branch — `request_oauth_on_install` goes to
   `false` in the manifest; `/setup/installed` already is the login-free
   post-install landing. `GitProvider` loses `label`, `authorizeUrl`,
   `exchangeCode`, `refreshGrant`, `fetchUser`, `checkRepoAccess` and keeps
   what a release needs: `id`, `pushUrl`, `createPullRequest`. `AccessCache`
   keeps path 1 only. `release.ts` uses the installation token only (the
   `LIVE_PUSH_URL_OVERRIDE` test hatch stays). `GITHUB_CLIENT_ID` /
   `GITHUB_CLIENT_SECRET` are no longer read; `create-app` stops writing them
   (installation tokens use the App id + private key). `@bpmiq/github-app/oauth`
   loses its last consumer and is deleted — the control plane dropped it in
   cloud PR #24; confirm before the vendor bump.

5. **Sessions are identity-only, everywhere.** `provider_token`,
   `refresh_token`, `token_expires_at` and the at-rest cipher leave
   `SessionStore`; `TokenGrant` / `updateGrant` go with them. ADR 0001's target
   state is reached. `SESSION_ENC_KEY` keeps its name (existing deployments,
   the cell env); its only remaining job is the HMAC key for the login `state`
   (fallback `CELL_TOKEN_KEY`; the `GITHUB_CLIENT_SECRET` link of the chain
   disappears). The installation-token cache (`TokenService`,
   `CELL_TOKEN_KEY`, `domain/crypt.ts`) is unaffected.

6. **What stays as is.** The OIDC resource server (`auth/oidc.ts`), the
   browser login (`auth/oidc-login.ts`), the editor sign-in (login code on the
   same flow), the ws ticket for the widget, the cell-mode machine credentials.
   The pasted-session-token command in VS Code (#173) is the last non-OAuth
   entrance; it is removed once every cell runs an image that serves
   `/auth/exchange` (separate PR, not gated on this ADR).

## Consequences

- **One identity contract, one authorization path.** `sessionOf` and
  `onAuthenticate` resolve through one principal resolver with two
  implementations (`auth/none.ts`, `auth/oidc.ts`). A future trusted-proxy
  mode (`X-Forwarded-User` behind oauth2-proxy) would be a third
  implementation behind the same seam — deferred until a customer asks.
- **The on-prem quickstart changes hands.** Today: register a GitHub App,
  paste five values, sign in with GitHub. Tomorrow: the same App **plus** an
  IdP that issues `github_login`. The only documented recipe is WorkOS
  (`docs/extending/mcp-idp-setup.md`). This ADR is not complete without a
  self-contained IdP quickstart: a Keycloak compose under `deploy/keycloak/`
  with a realm export (audience mapper, `github_login` user attribute → claim,
  a public PKCE client for the web login with redirect
  `<LIVE_PUBLIC_URL>/auth/oidc/callback`, a client for MCP), verified
  end-to-end before the docs claim it. Evaluation without any IdP is
  `LIVE_AUTH=none` — what the bare spike was for, now with the web app
  included.
- **Breaking release.** Removed env vars (`LIVE_DEV_TOKEN`,
  `GITHUB_CLIENT_ID`, `GITHUB_CLIENT_SECRET`), removed routes
  (`/auth/github*`), a required decision (`LIVE_AUTH=none`, or the `oidc`
  prerequisites), a required App for `oidc` mode. release-please:
  `BREAKING CHANGE` footers → 4.0.0. The operating-modes table
  (`docs/on-prem/README.md`), `configuration.md`, `deploy/.env.example`, the
  live-host README's authentication section and `docs/extending/sso.md` are
  rewritten in the same release.
- **Tests.** `stub-provider.ts` loses `/login/oauth/*`, `/user`,
  `/user/installations`; `release-e2e.sh` and the VS Code E2E run the host
  with `LIVE_AUTH=none`; `session-crypt.test.ts` goes; `access.test.ts` loses
  its path-2 cases; tests that need a named, authenticated identity use the
  in-process OIDC test IdP already in `oidc.test.ts` (local JWKS + `SignJWT`).
  `oauth-state.test.ts` stays — the state HMAC guards the OIDC flow.
- **Cloud.** Cells already run `oidc` mode by construction; `GITHUB_CLIENT_*`
  in the cell env become dead values to clean up in the provisioner
  (bpm-iq-cloud, later). `LIVE_AUTH` defaults to `oidc`, so the switch needs
  no cell env change.
- **Attribution.** Release commits keep deriving the noreply address from the
  git provider (`<login>@users.noreply.github.com`), not from the session's
  provider — unchanged. In `none` mode the login is whatever
  `LIVE_LOCAL_USER` says; in a container the OS fallback is `root`/`node`, so
  the variable is documented as expected, not optional.

## Rejected alternatives

- **Keep GitHub OAuth as a third mode ("login without IdP").** Keeps two
  session shapes, two authorization paths, stored user tokens and a second
  OAuth client — for deployments that by ADR 0005 cannot connect an AI client.
  The IdP requirement is already the product's shape; the third mode only
  postponed it.
- **Keep the dev token next to `none` mode.** An unverified bearer is theater
  with a config knob; its semantics equal `none` mode.
- **Infer `none` mode from missing configuration.** That is the current state,
  and the reason a guard had to be written and adversarially reviewed. One
  explicit line in `.env` costs less than an implicit mode.
- **Trusted-proxy header auth now.** No customer has asked; the principal
  resolver seam accommodates it later without touching this decision.
- **A self-built authorization server or password login.** Still rejected
  (ADR 0005). `none` mode is not a login; it is the declared absence of one.

## Rollout

Three stacked PRs on `main`, one major release:

1. **`none` mode replaces the dev token** — `LIVE_AUTH`, the principal
   resolver, `/api/config.auth`, web + VS Code adaptation, tests and scripts on
   `LIVE_AUTH=none`, `LIVE_DEV_TOKEN` removed. BREAKING for dev-token users.
2. **GitHub OAuth login and stored user tokens removed** — routes, port,
   `AccessCache` path 2, session columns + cipher, client credentials,
   `github-app/oauth`, manifest flag, `oidc` mode prerequisites. BREAKING.
3. **Docs + Keycloak quickstart** — `deploy/keycloak/`,
   `docs/on-prem/idp-quickstart.md`, rewritten modes/config/README/sso pages,
   `.env.example`.

PR 3's end-to-end verification (fresh host, Keycloak realm import, browser
login, MCP bearer, one release) is the exit criterion for the release — met
2026-09-13: `apps/live-host/test/keycloak-e2e.sh` proves the prerequisite
check, the browser login through Keycloak's form, an MCP bearer at `/api/me`
and `/mcp`, a release with human attribution, and fail-closed refusal of a
token without `github_login` at every entrance.
