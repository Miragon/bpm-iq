# On-premise installation

Self-host the bpmiq platform with Docker: one container runs the Live Host — Hocuspocus
document sync (WebSocket), the REST API, and the collaborative web app on **one port**.
Releases become pull requests in your own GitHub organization; review + merge stays where it
is today. The platform never executes code from a content repository.

The auth model in one line: **login authenticates, repositories authorize** — users sign in
via GitHub OAuth, and per-(user,repo) write permission is checked through your own GitHub
App's installation token. In app mode the server stores zero user tokens
([ADR 0001](../adr/0001-zero-stored-user-tokens.md)).

Companion documents:

- [configuration.md](configuration.md) — the complete environment reference
- [github-app-setup.md](github-app-setup.md) — registering your GitHub App (do this first)

## Prerequisites

- A GitHub organization (or GitHub Enterprise) holding your BPM content repositories.
- Docker with the compose plugin.
- A **public HTTPS URL** for the instance — the OAuth callback and webhook URLs derive from
  `LIVE_PUBLIC_URL`. A localhost evaluation works without one (webhooks simply can't reach
  you; the install-redirect fallback covers repo connection).
- Outbound HTTPS (443) to `github.com` and `api.github.com` — or your GHE hosts — for the
  API and for git clone/fetch/push. No SSH access is needed; all git traffic is HTTPS.

## The image

`ghcr.io/miragon/bpmiq-live-host` — multi-arch (linux/amd64 + linux/arm64), built from
[`apps/live-host/Dockerfile`](../../apps/live-host/Dockerfile) by the release workflow
(see [ADR 0004](../adr/0004-open-source-split.md) for the artifact flow — the same image
serves on-prem installs and Miragon's hosted cells).

| Tag              | Meaning                                        |
| ---------------- | ---------------------------------------------- |
| `latest`         | latest release — pin `vX.Y.Z` for production   |
| `vX.Y.Z`         | a specific release                             |
| `edge`           | latest `main` build                            |
| `sha-<full-sha>` | exact commit build (full sha, for pin-mapping) |

Container facts: listens on `PORT=8080`, state under `LIVE_DATA_DIR=/data` (mount a
volume there), ships `git` + CA certificates for cloning connected repos. The container
currently runs as **root** so a freshly mounted volume is writable out of the box — if your
policy requires a non-root user, run with `user:` and make `/data` writable for that uid.

## Quickstart (compose)

1. Register your GitHub App — [github-app-setup.md](github-app-setup.md). You come back
   with an app id, slug, client id/secret, private key, and webhook secret.
2. Configure and start:

   ```bash
   cd deploy
   cp .env.example .env        # fill in LIVE_PUBLIC_URL + the GitHub App values
   docker compose up -d
   ```

   The compose file is [`deploy/docker-compose.yml`](../../deploy/docker-compose.yml); the
   annotated env template is [`deploy/.env.example`](../../deploy/.env.example). It sets
   `stop_grace_period: 30s` so the graceful-shutdown flush (`LIVE_SHUTDOWN_MS`, 25 s) can
   persist debounced write-throughs before the container is killed — keep that headroom if
   you write your own unit files.

3. Put your reverse proxy in front (below), open `https://<your-host>`, sign in with
   GitHub, connect repositories via GitHub's install picker. Done.

Plain `docker run` works too:

```bash
docker run -d --name bpmiq -p 8080:8080 -v bpmiq-data:/data \
  --env-file .env --stop-timeout 30 ghcr.io/miragon/bpmiq-live-host:latest
```

## Operating modes

The server wires itself from the credentials it finds ([configuration.md](configuration.md)
has every variable):

| Mode                         | Credentials                                 | What you get                                                                                                                                                                                           |
| ---------------------------- | ------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Bare spike                   | none                                        | Serves a locally mounted content checkout (`LIVE_HOST_CONTENT_DIR`), dev token `demo`. Local evaluation only — no login, no authorization.                                                             |
| OAuth-only                   | `GITHUB_CLIENT_ID` + `GITHUB_CLIENT_SECRET` | GitHub login + the single static `GITHUB_REPO`.                                                                                                                                                        |
| **GitHub App** (recommended) | App id + private key (+ OAuth creds)        | Installation enumeration = multi-repo overview, per-(user,repo) authorization via installation tokens, bot-authored release PRs ([ADR 0001](../adr/0001-zero-stored-user-tokens.md)), direct webhooks. |

Run on-prem in **GitHub App mode**. There is also a cell mode (extra `TENANT_*`/`CELL_*`
variables) used by Miragon's hosted multi-tenant operation
([ADR 0002](../adr/0002-multi-tenant-cell-architecture.md)) — leave all of those unset;
the server then runs standalone.

## Reverse proxy / TLS

One port carries plain HTTP **and** the WebSocket upgrade (Hocuspocus rides the same
server). A proxy that doesn't pass the upgrade through is the #1 misconfiguration: the app
loads, but documents never sync.

Caddy — upgrade pass-through is automatic:

```
bpm.example.com {
    reverse_proxy localhost:8080
}
```

nginx — needs HTTP/1.1 and the Upgrade/Connection headers explicitly:

```nginx
map $http_upgrade $connection_upgrade {
    default upgrade;
    ''      close;
}

server {
    listen 443 ssl;
    server_name bpm.example.com;
    # ssl_certificate ...; ssl_certificate_key ...;

    location / {
        proxy_pass http://localhost:8080;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection $connection_upgrade;
        proxy_set_header Host $host;
        proxy_read_timeout 1h;   # long-lived WebSocket connections
    }
}
```

`LIVE_PUBLIC_URL` must be the public HTTPS URL — session cookies are only marked `Secure`
when it starts with `https`, and OAuth callback + webhook URLs derive from it.

One cap to know about: the per-IP WebSocket limit (`LIVE_MAX_WS_PER_IP`, default 40)
identifies clients by the `Fly-Client-IP` header, falling back to the socket address —
behind your proxy that fallback is the **proxy's** address, so all users share one bucket.
Either set the header at the proxy (`proxy_set_header Fly-Client-IP $remote_addr;` — safe,
since clients can only reach the app through the proxy) or raise the limit.

## Data & backup

Everything lives under `/data`:

| Path                              | What                                                                                                           | Backup?                            |
| --------------------------------- | -------------------------------------------------------------------------------------------------------------- | ---------------------------------- |
| `/data/live.db`                   | SQLite: **live document lineages** (unreleased edits — the crown jewels), sessions, repo registry, token cache | **Yes**                            |
| `/data/workspaces/<owner>/<repo>` | git checkouts of connected repos, cloned on demand                                                             | No — re-cloneable, safe to exclude |

Backup: `sqlite3 /data/live.db ".backup /backups/live.db"` (consistent while the server
runs) or snapshot the whole volume. Restore: restore `/data`, start the container —
lineages, sessions, and the registry come back; workspaces re-clone as needed.

Released state is safe in GitHub regardless; only unreleased live edits depend on
`live.db`. Frequent, small releases keep that exposure short.

## Upgrades

```bash
docker compose pull && docker compose up -d
```

Pull the new tag and recreate — SIGTERM triggers the graceful flush, `/data` carries the
state across. Releases are semver-tagged; breaking changes (env, data layout) are called
out in the release notes. For production, pin `vX.Y.Z` and move deliberately.

## Health

`GET /healthz` — liveness plus a deep check: SQLite writability and disk headroom (<5 %
free = degraded). `200` with `status: "ok"`, or `503` with `status: "degraded"`:

```json
{ "status": "ok", "tenant": null, "liveDocs": 3, "sqlite": "ok", "diskFreeMb": 51234, "diskUsedPct": 37 }
```

Standalone (on-prem) the full detail is public — a single-tenant box has nothing to gate.
Only in cell mode is the detail reduced to `{ "status": ... }` unless the poller presents
the cell secret as a bearer token. Point your monitoring at the status code.
