# Multi-repo architecture — gap analysis

> **Status (2026-07-08): MR-1 + MR-2 implemented** — installation registry (app JWT +
> webhook receiver + static fallback), workspace manager (clone on demand, host repo =
> this checkout), repo-qualified rooms incl. lineage migration, per-(user,repo)
> authorization (login authenticates, repos authorize), repo overview + repo-scoped
> routes/release. Verified: 13-check browser E2E.
>
> **Update (2026-07-09): provider seam split + GitLab groundwork.**
>
> - The provider abstraction is now TWO interfaces: `GitProvider`
>   (user-credentialed: OAuth incl. `TokenGrant` refresh, permission gate, push,
>   PR — `src/auth/provider.ts`) and `RepoConnectionSource`
>   (platform-credentialed: connected-repo enumeration, clone tokens, connect
>   URL, webhook verification — `src/repos/connection-source.ts`). The GitHub
>   App mechanics are one implementation of the source; a GitLab source (OAuth
>   application + explicit project selection or group tokens, `X-Gitlab-Token`
>   webhooks) is a second implementation, not a rewrite.
> - **User-token refresh implemented**: `exchangeCode` keeps
>   `refresh_token`/`expires_at`, sessions persist the grant, `AccessCache`
>   refreshes transparently and invalidates the session on a dead grant.
> - **Repo identity is multi-segment**: rooms, API routes and web routes match
>   the repo as the longest registry prefix, so GitLab subgroup paths
>   (`group/sub/project`) are representable end to end. Still open for GitLab:
>   repo RENAMES change the identity key (rooms, SQLite lineage PKs, workspace
>   dirs). Migration path when it bites: introduce an opaque registry key
>   (`gh_<id>`/`gl_<id>`), make `fullName` a display attribute, migrate
>   `documents.name` once (`UPDATE … SET name = replace(...)`), and redirect
>   old client deep links at the API layer.
> - Uninstalled connections now prune their repos (previously they stayed
>   connected forever); transient listing failures still never prune.
>
> Open (MR-3): public app flip, portal/MCP multi-tenancy, rate-limit handling,
> GitLab `RepoConnectionSource` + `GitProvider` implementations.

**Target state** (decided 2026-07-08): one Live Host instance serves **many content
repositories**; a **repo overview** screen lists them; the central GitHub App becomes
**public**, so any org/user can install it on their repos. This document is the gap
analysis between that target and today's code — produced from a 4-track code audit
(live-host core, clients, GitHub-App mechanics, content pipeline; 67 findings with
file:line evidence, condensed here).

## The one architectural fact everything inherits

**The Live Host is a tenant of itself.** `REPO_ROOT` is the server's own git checkout
(`server.ts:39`), `GITHUB_REPO` statically names the one content repo, and every
subsystem silently inherits that: Yjs room names are bare repo-relative paths, SQLite
keys are bare paths, disk resolution/guards, the process list, git operations, release
worktrees, and authorization all assume "the repo". Multi-repo is therefore not a
feature toggle but the removal of one implicit global.

**Why it must be fixed before connecting a second repo** — the collision scenario is
data loss, not inconvenience: if two connected repos both contain
`processes/order-to-cash/order-to-cash.bpmn`, (1) their clients join the _same_
Hocuspocus room (room = bare path) and the two unrelated documents CRDT-merge; (2) the
SQLite `documents` row (PK = name) holds one shared lineage, so a restart restores repo
A's history into repo B's session; (3) write-through resolves against the single
`REPO_ROOT` — silent cross-tenant file corruption.

## Gap areas (in dependency order)

### A. App credentials — one-shot loss already happened

The manifest conversion returns the app **private key (pem)** and **webhook secret**
exactly once. `create-app` used to discard both (fixed now: persisted as
`GITHUB_APP_PRIVATE_KEY_B64` / `GITHUB_WEBHOOK_SECRET`). Without the pem there is no
RS256 app JWT → no `GET /app/installations` → no installation-derived repo list.

- The **existing `bpm-live` app's key is unrecoverable** — generate a new private key
  once in the app settings (org → Developer settings → BPM Live → Private keys) and
  add it to `.env` (base64). Same for the webhook secret when the webhook is enabled.
- `GITHUB_APP_ID` is written but read nowhere yet — it becomes the JWT issuer.
- Manifest is `public: false` → flip to **public** (app settings "Make public", or
  `public: true` for future creations) so foreign orgs/users can install.
- App ownership is derived from the content repo's org (`OWNER = GITHUB_REPO.split('/')[0]`)
  — must become an explicit vendor setting (`APP_OWNER_ORG`), independent of content.

### B. Installation registry (new subsystem — the backbone)

Nothing today records where the app is installed; `/setup/installed` discards
`installation_id` (`api.ts:203`). Needed:

- **App-JWT signer** (RS256, `iss` = app id, ~10 min expiry — Node `crypto` suffices,
  no dependency needed) + **installation-token cache** (1 h tokens, expiry-aware
  refresh, strictly per installation — never cross-org).
- **Enumeration**: `GET /app/installations` (paginated) → per installation
  `GET /installation/repositories` — seeded at startup, refreshed on demand.
- **Webhook receiver** `POST /webhook/github` with `X-Hub-Signature-256` verification,
  handling `installation` (created/deleted/suspend/unsuspend) and
  `installation_repositories` (added/removed). The app's webhook must be registered
  active (today: inactive/omitted). Local dev: tunnel (`LIVE_WEBHOOK_URL`), plus
  `/setup/installed` handling `installation_id` as the webhook-less fallback.
- **Persistence**: new SQLite tables (installations, repositories) next to
  documents/sessions. This registry **is** the data source of the repo overview.

### C. Workspace manager

- One working directory per connected repo (`workspaces/<owner>/<repo>`),
  cloned/fetched with **installation tokens** (the host can no longer rely on the
  ambient credentials of its own checkout). The server binary becomes deployable
  outside any content repo.
- `live.db` moves out of the content repo's tree (`REPO_ROOT/.live`) into a host-owned
  `LIVE_DATA_DIR`; `webDist` likewise resolves relative to the install location, not
  the content repo (`server.ts:146`).
- `BASE_BRANCH` becomes per-repo (`repository.default_branch` from the registry).

### D. Repo-namespaced collaboration protocol (client/server lockstep)

- **Room name** gains the repo dimension: `<owner>/<repo>/<path>` (today: bare path —
  `server.ts:162`, `web/editor.ts:48`, `vscode/extension.ts:38`).
- SQLite `documents` key → repo-qualified (+ migration of existing rows).
- `toDiskPath` parses the repo segment, resolves against that repo's workspace, guards
  against filesystem **and cross-repo** escape.
- `liveDocs` tracked per repo (today one flat set — counts leak across repos).
- VS Code: repo moves into the document path — `bpm-live:/<owner>/<repo>/<path>`
  (implemented path-based, not via the URI authority).

### E. AuthN/AuthZ split: login authenticates, repos authorize

Today the OAuth callback denies login entirely without write access to _the_ repo
(`api.ts:230`), and any session may open any room (`server.ts:94`). Target:

- **Login = authentication only.** After login: repo list = app installations ∩ the
  user's per-repo permission. A user with access to _any_ connected repo gets in.
- **Per-(user,repo) authorization at request/room-join time**: HTTP routes and ws
  `onAuthenticate` derive the repo from the route/room and check permission, cached
  per session+repo (invalidated by installation webhooks). `#/denied` dies as a global
  route; "no access" becomes a per-repo state (hidden/read-only card).
- `GitProvider` interface change (ripples into github.ts + stub): `checkRepoAccess`,
  `pushUrl`, `createPullRequest` take the repo per call; new app-level capability
  (installations listing) lives beside it, since it is app- not user-credentialed.
- **Expiring user tokens**: manifest-created apps default to 8 h user tokens with
  refresh tokens — `exchangeCode` discards `refresh_token`/`expires_in` today while
  sessions live 12 h. Store + proactively refresh (or consciously disable expiry in
  app settings and document it).
- The dev token would grant headless write to **every** connected repo — scope it
  (repo allowlist) or restrict to single-tenant/dev mode.

### F. Repo-scoped API + the overview screen

Routes gain the repo dimension: `GET /api/repos` (overview),
`GET /api/repos/:owner/:repo/processes`, `POST /api/repos/:owner/:repo/release/:id`;
web routing `#/` = overview, `#/r/<owner>/<repo>` = process list,
`#/r/<owner>/<repo>/p/<id>` = editor. Release branch names, audit logs and PR bodies
carry the repo identity. `LIVE_PUSH_URL_OVERRIDE` (test escape hatch) becomes per-repo
or a URL template.

**Overview payload per repo** (from the registry + workspace, filtered to the session
user): owner/name, avatar, default branch; connection status (installed / suspended /
unreachable); the **user's effective permission** (write/read/none → editable,
read-only, hidden); process count (total / with BPMN); live-session count; dirty count
(unreleased changes); last activity. "Connect another repository" = the public app's
generic install URL — the install picker then does what it always did.

### G. Platform/content split (portal, MCP, validation)

The content repo currently carries platform machinery. For N repos, the machinery
moves host-side; connected repos ship **content only**:

- **Validation**: releasing no longer runs any validator (the content contract is now
  just `bpmiq.yml` + `.bpmn` files — see "The repo contract" below). Historically
  `release()` executed `node scripts/validate.ts` _from the content repo_, which under a
  public app was **remote code execution by any third-party repo on the host**. If
  release-time validation returns, it must ship with the platform (pinned, versioned,
  `validate --root <checkout>`), never run repo code — the packaged `@bpmiq/validator`
  already works this way for the `process-documentation/` example.
- **Portal**: `.vitepress/` (config, theme, viewers, `processes/[id].paths.ts`) is
  portal _code_ interleaved with content and builds exactly one site from one repo.
  It moves platform-side, parameterized by checkout, served per repo
  (`/:owner/:repo/…`). Content updates arrive via webhook-synced checkouts — not by
  redeploying the service with content baked into the image (today's deploy.yml).
- **MCP**: `tools.ts` is already root-parameterized (`createMcpServer(root)` — the one
  multi-repo-ready seam found); `http.ts` always serves `DEFAULT_ROOT`. Route per repo
  (`POST /mcp/:owner/:repo`) or add a repo argument + `list_repositories` tool.
  Cross-repo impact analysis becomes a new platform capability.
- **Skill export**: per-repo resolution and output; the platform needs a cross-repo
  view of published skills (overview badge).

## The repo contract (what a connected repo must fulfill)

The contract is deliberately minimal (v0, `starter/` mirrors it to the template
repo): a **`bpmiq.yml` at the repo root** naming the folder the BPMN processes
live in (`processes: <folder>`). Every `.bpmn` under that folder is a process
(id = file name without extension); a repo without the config is simply not a
content repo — the Live Host neither lists nor serves it, and live rooms exist
only inside the configured folder. The richer starter layout of the past
(`process.yaml` metadata, `landscape/`, `INDEX.md`, governance fields) lives on
in `process-documentation/` as the internal example consumed by validator,
portal and MCP; those conventions grow back into the contract as it evolves.

## Suggested milestones

| Milestone                                    | Scope                                                                                                                                                                                                                                                  | Unlocks                                                 |
| -------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------- |
| **MR-1: registry + overview (read)**         | Persist pem/webhook secret (done for future apps; regenerate key for `bpm-live`), app-JWT + installation enumeration, webhook receiver, `GET /api/repos`, overview screen. Editing still single-repo.                                                  | The Übersicht; "connect repo" UX; public-app groundwork |
| **MR-2: multi-repo editing + release**       | Workspace manager, namespaced rooms + persistence migration, per-(user,repo) authZ, repo-scoped routes, VS Code URI authority, per-repo release.                                                                                                       | Full multi-repo collaboration                           |
| **MR-3: public app + multi-tenant pipeline** | Register a SEPARATE production app (see below), platform-owned validator (no repo code execution), portal/MCP per repo from webhook-synced checkouts, token refresh, rate-limit handling, org isolation review, **+ the app-key security gate below**. | Foreign orgs onboard themselves                         |

## The production public app is a SEPARATE app — not the dev app flipped

The app `create-app` registers (`bpm-live`, private, ad-hoc name, key that has been on a dev
machine) is a **development app**. Going public does **not** mean flipping it — the public,
multi-tenant production app is a **distinct GitHub App**, created deliberately once:

- its own app id, client id/secret, private key and webhook secret — **none shared** with the
  dev app; the dev key never becomes a production credential;
- a clean identity (name "BPM Live", logo, homepage, verified publisher), `public: true`,
  webhook pointed at the production URL;
- key **born in the secret manager**, never written to a developer's disk.

This separation is _why_ the local-dev conveniences (a `.pem` sitting in `apps/live-host/`,
key in `.env`) are fine: the dev app only ever touches repos someone deliberately installed it
on for testing, and it is not the identity foreign tenants trust. The strict handling below
applies to the **production** app.

## Security gate: the production app's private key

The GitHub App private key is the **trust anchor of the whole model**: signing an app JWT
with it mints installation tokens for **every org that installed the app**, bounded only by
the app's permissions. For the **dev app** (one org — Miragon's own repos) a key in `.env` /
a `.pem` in the dir is acceptable. **For the production public app, ALL of the following must
hold before it serves any foreign tenant — a hard gate, not a nice-to-have:**

1. **Key off disk, into a secret manager.** Move `GITHUB_APP_PRIVATE_KEY_B64` (and
   `GITHUB_WEBHOOK_SECRET`) out of `.env` into the platform's secret store (Fly secrets /
   Vault / KMS), injected at runtime. Never in the image, never committed, never on a
   persistent volume. `.env`-on-disk stays single-tenant only.
2. **Key rotation, planned from day one.** GitHub Apps allow multiple private keys
   concurrently: generate the new key, deploy it, then revoke the old one — zero downtime.
   Have the rotation runbook ready _before_ public, not after an incident.
3. **Least privilege, kept minimal.** The app requests only `contents` + `pull_requests`
   (write) + `metadata` (read) — no admin, no org scope, no Actions/secrets. This is what
   bounds the blast radius of a full key compromise (no repo deletion, no org-settings
   change, no secret exfiltration). Every added permission is a deliberate risk decision and
   must be justified in review.
4. **Blast-radius facts to preserve** (already true in the code — keep them true): installation
   tokens are per-installation and expire in ~1 h; `registry.sync()` uses each installation's
   own token and never a cross-org one; the app can only reach repos where it is explicitly
   installed. Any change that widens these (a shared token, a longer-lived token, an ambient
   credential) re-opens the gate.

Rationale and the single-tenant-is-fine-for-now framing: see the 2026-07-08 discussion —
the key concentrates risk in one well-guarded place, which is _better_ than spraying
per-user tokens across every user, but only if that one place is actually guarded.

## Immediate to-dos (cheap now, expensive later)

1. ~~Persist `pem` + `webhook_secret` in create-app~~ (done, 2026-07-08).
2. Generate a private key for the DEV app `bpm-live` (org → Developer settings → BPM Live →
   Private keys → Generate) and give it to the server — simplest for local dev: drop the
   downloaded `.pem` into `apps/live-host/` (auto-detected; `*.pem` is gitignored), or set
   `GITHUB_APP_PRIVATE_KEY_FILE` / `GITHUB_APP_PRIVATE_KEY_B64`.
3. When going public: **register a NEW production app** (separate identity + credentials, key
   in the secret manager) — do NOT flip the dev app. Gate above must be met first.
4. Treat every new `GITHUB_REPO`-shaped assumption in code review as a defect — the
   env var is scheduled to disappear.
