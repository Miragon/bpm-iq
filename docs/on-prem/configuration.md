# Configuration reference

Every environment variable the Live Host reads, grouped by concern. Defaults in parentheses
are the source defaults ([`apps/live-host/src/server.ts`](../../apps/live-host/src/server.ts)
is the only place that reads env); the Docker image overrides two of them (`PORT=8080`,
`LIVE_DATA_DIR=/data`). The annotated deployment template is
[`deploy/.env.example`](../../deploy/.env.example).

See [README.md](README.md) for the install guide and
[github-app-setup.md](github-app-setup.md) for obtaining the GitHub App values.

## Core

| Variable                | Default                         | Meaning                                                                                                                                                                                                       |
| ----------------------- | ------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `PORT`                  | `8301` (image: `8080`)          | The one port for everything: REST API + WebSocket sync + web app.                                                                                                                                             |
| `LIVE_PUBLIC_URL`       | `http://localhost:$PORT`        | **Must be the public HTTPS URL in production.** The OAuth callback and webhook URLs derive from it, and session cookies are only marked `Secure` when it starts with `https`.                                 |
| `LIVE_DATA_DIR`         | `<repo>/.live` (image: `/data`) | Host-owned state: `live.db` (Yjs lineages, sessions, repo registry, token cache) + `workspaces/` (cloned repos). Mount a volume here.                                                                         |
| `GITHUB_REPO`           | `Miragon/bpm-iq`                | Static fallback repository (`<owner>/<repo>`) registered when the GitHub App cannot enumerate installations — the single-repo mode. Set it to your own content repo; in app mode the installations take over. |
| `BASE_BRANCH`           | `main`                          | Default branch recorded for the static fallback repo (release PRs target the repo's default branch).                                                                                                          |
| `LIVE_HOST_CONTENT_DIR` | `<repo>` (the checkout root)    | Serve a local content checkout in place of cloning `GITHUB_REPO` — takes effect only when the directory has a root `bpmiq.yml`. Dev mode; not for production.                                                 |

## Login — GitHub OAuth

The simplest authenticated mode: login + the single static `GITHUB_REPO`. In app mode these
are the app's own OAuth credentials (the guided setup writes them for you).

| Variable               | Default | Meaning                                 |
| ---------------------- | ------- | --------------------------------------- |
| `GITHUB_CLIENT_ID`     | —       | OAuth client id — enables GitHub login. |
| `GITHUB_CLIENT_SECRET` | —       | OAuth client secret.                    |

## GitHub App mode (recommended on-prem)

App id + private key switch the server into multi-repo mode: installation enumeration
drives the repo overview, per-(user,repo) authorization runs on installation tokens
([ADR 0001](../adr/0001-zero-stored-user-tokens.md)), and webhooks keep the connected set
current. Setup walkthrough: [github-app-setup.md](github-app-setup.md).

| Variable                | Default | Meaning                                                                                                                        |
| ----------------------- | ------- | ------------------------------------------------------------------------------------------------------------------------------ |
| `GITHUB_APP_ID`         | —       | The app's numeric id.                                                                                                          |
| `GITHUB_APP_SLUG`       | —       | The app's URL slug — powers the "connect repository" install-picker link and app-mode login. Without it users can't add repos. |
| `GITHUB_WEBHOOK_SECRET` | —       | Verifies `POST /webhook/github` (HMAC SHA-256). The receiver fails closed: no secret configured = webhooks refused with `503`. |

The **app private key** is resolved by the shared loader
([`packages/github-app/src/index.ts`](../../packages/github-app/src/index.ts),
`loadPrivateKey`) — first match wins:

1. `GITHUB_APP_PRIVATE_KEY` — the raw PEM (a double-quoted multi-line `.env` value; must
   contain `PRIVATE KEY`)
2. `GITHUB_APP_PRIVATE_KEY_FILE` — path to a `.pem` file (mount the key as a file/secret)
3. `GITHUB_APP_PRIVATE_KEY_B64` — base64 one-liner (env-only deploys; what the guided
   setup writes)
4. the first `*.pem` found in `apps/live-host/` — local-dev convenience for source
   checkouts, not relevant in the container

`LIVE_WEBHOOK_URL` is read only by the `create-app` tool (it sets the webhook URL in the
app manifest, defaulting to `$LIVE_PUBLIC_URL/webhook/github` when the public URL isn't
localhost). The running server always receives webhooks at `/webhook/github`.

## OIDC — token auth (MCP & headless) + browser SSO

Connects the Live Host to your identity provider (Keycloak, Entra ID, WorkOS, Auth0, … —
GitHub as a social connection behind it), for two things on ONE identity contract:

1. **Token auth**: MCP clients and other headless callers authenticate with an
   audience-bound JWT. The Live Host only **verifies** tokens (a resource server); it
   never runs its own authorization server.
2. **Browser SSO** (optional, `LIVE_OIDC_CLIENT_ID`): the web login redirects to the
   IdP's hosted flow (authorization code + PKCE) instead of GitHub OAuth. The flow's
   access token is validated by the **same verifier** as MCP bearers — same issuer,
   audience and login claim, fail-closed. Without a client id, browser login stays
   GitHub OAuth (zero extra prerequisites).

Identity is not authorization: per-repo write permission is still checked app-side
against real GitHub permissions, which requires the GitHub-App connection source
(OIDC sessions hold no user token). When configured, the server publishes RFC-9728
protected-resource metadata at `/.well-known/oauth-protected-resource` and 401 responses
carry `WWW-Authenticate: Bearer resource_metadata="…"`, so MCP clients discover your IdP
automatically. A verified, click-by-click IdP setup (WorkOS AuthKit) lives in
[extending/mcp-idp-setup.md](../extending/mcp-idp-setup.md). Decision record:
[ADR 0005](../adr/0005-in-process-mcp-and-oidc-resource-server.md).

| Variable                  | Default           | Meaning                                                                                                                                                                                             |
| ------------------------- | ----------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `LIVE_OIDC_ISSUER`        | —                 | The IdP's issuer URL (expected `iss` claim). Must be set together with `LIVE_OIDC_JWKS_URL` — one without the other refuses startup.                                                                |
| `LIVE_OIDC_JWKS_URL`      | —                 | The IdP's JWKS endpoint, used to verify token signatures.                                                                                                                                           |
| `LIVE_OIDC_AUDIENCE`      | `LIVE_PUBLIC_URL` | The audience (`aud`) tokens must be bound to — this instance.                                                                                                                                       |
| `LIVE_OIDC_LOGIN_CLAIM`   | `github_login`    | The claim carrying the user's GitHub login. **Must be IdP-populated with the verified GitHub login — never user-editable.** A token without it is refused (no `preferred_username`/`sub` fallback). |
| `LIVE_OIDC_CLIENT_ID`     | —                 | Enables **browser SSO**: the web login runs the IdP's code+PKCE flow. Requires the issuer/JWKS pair above (the flow's access token is verified by that config).                                     |
| `LIVE_OIDC_CLIENT_SECRET` | —                 | Optional — set for a confidential client (Keycloak default); unset = public client, PKCE only.                                                                                                      |
| `LIVE_OIDC_AUTHORIZE_URL` | discovery         | Explicit authorize endpoint. Default: resolved from `<issuer>/.well-known/openid-configuration` (lazily, cached). Set both URL overrides for air-gapped hosts.                                      |
| `LIVE_OIDC_TOKEN_URL`     | discovery         | Explicit token endpoint (see above).                                                                                                                                                                |
| `LIVE_OIDC_LOGIN_LABEL`   | `SSO`             | The web client's login-button label (e.g. "Acme SSO").                                                                                                                                              |
| `LIVE_MCP_READONLY`       | —                 | `1` = the MCP endpoint registers **no** write tools (absent from `tools/list`, not erroring).                                                                                                       |

The IdP-side requirement is identical for both entrances: access tokens must be JWTs
carrying the audience and the login claim (Keycloak: an audience mapper + a
user-attribute mapper on the client; Entra ID: an optional claim fed from a directory
attribute; WorkOS: a JWT template). What works for `/mcp` works for the browser login
and vice versa.

## GitHub Enterprise

| Variable          | Default                  | Meaning                                           |
| ----------------- | ------------------------ | ------------------------------------------------- |
| `GITHUB_BASE_URL` | `https://github.com`     | Web base — login, install picker, git clone URLs. |
| `GITHUB_API_URL`  | `https://api.github.com` | REST API base.                                    |

## Security & limits

| Variable             | Default     | Meaning                                                                                                                                                                                                                                                       |
| -------------------- | ----------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `SESSION_ENC_KEY`    | see meaning | Encrypts provider tokens persisted in `live.db` at rest (key is sha256-derived), so a leaked database yields no usable GitHub credential. Fallback chain: `SESSION_ENC_KEY` → `CELL_TOKEN_KEY` → `GITHUB_CLIENT_SECRET`. **Set it explicitly in production.** |
| `LIVE_MAX_DOC_BYTES` | `8000000`   | Per-room document size cap (DoS guard), enforced at ingest and at persist.                                                                                                                                                                                    |
| `LIVE_MAX_WS`        | `400`       | Global WebSocket connection ceiling.                                                                                                                                                                                                                          |
| `LIVE_MAX_WS_PER_IP` | `40`        | Per-IP WebSocket ceiling. Client IP = `Fly-Client-IP` header, falling back to the socket address — behind a reverse proxy, set the header at the proxy or all users share one bucket (see [README.md](README.md#reverse-proxy--tls)).                         |
| `LIVE_SHUTDOWN_MS`   | `25000`     | Graceful-shutdown budget: on SIGTERM/SIGINT the server flushes debounced write-throughs, hard-exiting after this many ms. Keep it below the container runtime's kill timeout (compose sets `stop_grace_period: 30s`).                                         |

## Dev/test only — never set in production

| Variable                 | Meaning                                                                                                                                                                                                                                                                                                                                                                                                      |
| ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `LIVE_DEV_TOKEN`         | Bot session token for headless clients (`Authorization: Bearer <token>` — also accepted on `POST /mcp` and the `/api/repos/:owner/:repo/content` routes). **It bypasses per-repo authorization entirely** — all-repos access. Defaults to `demo` only in the bare local spike (no login provider AND no GitHub App configured); the moment any provider exists it is off unless set explicitly. Leave unset. |
| `LIVE_GIT_URL_OVERRIDE`  | Redirect clone/fetch URLs to a stub git server — test harness.                                                                                                                                                                                                                                                                                                                                               |
| `LIVE_PUSH_URL_OVERRIDE` | Redirect release pushes to a stub git server — test harness.                                                                                                                                                                                                                                                                                                                                                 |

## Cell mode — leave unset on-prem

`TENANT_INSTALLATION_ID`, `TOKEN_MINT_URL`, `CELL_SECRET`, `CELL_TOKEN_KEY`,
`HANDOFF_SECRET` are used by Miragon's hosted multi-tenant operation, where a control plane
holds the GitHub App key and each tenant gets its own cell
([ADR 0002](../adr/0002-multi-tenant-cell-architecture.md),
[ADR 0004](../adr/0004-open-source-split.md)). Leave **all** of them unset — the server
then runs standalone with its own app key, which is the on-prem model.

When `TENANT_INSTALLATION_ID` **is** set (cell mode) **and** `LIVE_OIDC_*` is configured,
the OIDC verifier additionally requires every token to carry `installation_id` equal to
this cell's tenant, refusing anything else with `401 auth/wrong-tenant`. This is the tenant
boundary in the SaaS, where the OIDC audience is a shared fleet value (the IdP's resource
indicators are one per environment, not per tenant): the claim is IdP-injected from the
user's organization membership, so a token minted for another tenant fails here. On-prem
(single tenant, `TENANT_INSTALLATION_ID` unset) this check is inert.
