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
| `LIVE_HOST_CONTENT_DIR` | `<repo>/process-documentation`  | Serve a local content checkout in place of cloning `GITHUB_REPO` — takes effect only when the directory contains `processes/`. Dev mode; not for production.                                                  |

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

| Variable                 | Meaning                                                                                                                                                                                                                                                                                                                      |
| ------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `LIVE_DEV_TOKEN`         | Bot session token for headless clients (`Authorization: Bearer <token>`). **It bypasses per-repo authorization entirely** — all-repos access. Defaults to `demo` only in the bare local spike (no login provider AND no GitHub App configured); the moment any provider exists it is off unless set explicitly. Leave unset. |
| `LIVE_GIT_URL_OVERRIDE`  | Redirect clone/fetch URLs to a stub git server — test harness.                                                                                                                                                                                                                                                               |
| `LIVE_PUSH_URL_OVERRIDE` | Redirect release pushes to a stub git server — test harness.                                                                                                                                                                                                                                                                 |

## Cell mode — leave unset on-prem

`TENANT_INSTALLATION_ID`, `TOKEN_MINT_URL`, `CELL_SECRET`, `CELL_TOKEN_KEY`,
`HANDOFF_SECRET` are used by Miragon's hosted multi-tenant operation, where a control plane
holds the GitHub App key and each tenant gets its own cell
([ADR 0002](../adr/0002-multi-tenant-cell-architecture.md),
[ADR 0004](../adr/0004-open-source-split.md)). Leave **all** of them unset — the server
then runs standalone with its own app key, which is the on-prem model.
