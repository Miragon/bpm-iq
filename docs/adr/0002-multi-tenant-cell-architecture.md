# ADR 0002 — Multi-tenant SaaS: cell per tenant + thin control plane

- **Status:** accepted (2026-07-10)
- **Context:** SaaS-on-GitHub product direction; design adversarially reviewed
  2026-07-10 against Fly.io docs, GitHub platform limits, and SaaS-ops
  (3 blockers + 12 majors found and folded in below)
- **Related:** [0001](0001-zero-stored-user-tokens.md) (auth model)

## Context

The Live Host is deliberately a **single-writer process**: Hocuspocus (Yjs
collab, in-memory docs) + REST API + web app on one port, state in SQLite
(sessions, Yjs lineages, repo registry) + git workspaces on a local Fly volume.
As a _shared_ multi-tenant system this is a liability (scaling ceiling, noisy
neighbours, blast radius). As **one cell per tenant** it is an asset — today's
code already is almost the cell, and the GitHub App **installation (org) is the
natural tenant boundary**. GitHub's per-installation rate limits, one-webhook-
per-app model, and exact-match OAuth callback constraint all push toward the
same shape. Fly's own "per-user dev environments" blueprint documents this
exact pattern (subdomain router + `fly-replay` + volume-backed stateful cells).

## Decision

**Shared control plane + a cell per tenant.**

### Control plane (new, small, must stay available)

- Login (central GitHub App OAuth), tenant discovery via `GET /user/installations`,
  marketing, Stripe billing.
- **Tenant directory** in _managed_ Postgres (not self-hosted Fly PG — it is the
  fleet's availability keystone; Neon/Supabase/Fly Managed PG).
- **Provisioner** (Fly Machines API) modelled as a **state machine** keyed on
  `installation_id`: `provisioning → ready → suspending → destroying`. Fly
  resource names are deterministic (`cell-<installation_id>`) so retries
  converge instead of duplicating. Idempotency table keyed on
  `X-GitHub-Delivery`. A **reconciler** diffs `GET /app/installations` and the
  Fly org's apps/volumes against the directory both ways (missing → provision,
  orphaned → alert/GC).
- **Token-minting service** — the GitHub App **private key lives ONLY here**.
  Cells call `POST /internal/token` with their per-cell secret; the plane mints
  a 1h installation token **for that tenant's installation only**. This one
  component is **redundant** (2+ machines, stateless bar a directory read).
- **Webhook receiver** (the app's single webhook URL) — verifies HMAC, routes
  lifecycle events, forwards repo events to cells **re-signed with the per-cell
  secret** (cells never learn the app webhook secret). Webhooks are treated as
  an _optimization_, not the source of truth (see blocker W below).
- **Router**: tenant subdomains (`org.bpmiq.com`, wildcard cert) → `fly-replay`
  to the tenant's cell app (works for websocket upgrades). Login handoff: plane
  authenticates, redirects to the cell with a short-lived signed handoff token;
  the cell mints its LOCAL session (no shared cookie).

### Cell (= today's Live Host, "cell-ified")

- `TENANT_INSTALLATION_ID`: registry/connection-source filtered to one
  installation; SQLite/workspaces/lineages contain only that org's data.
- Token client: `installationToken()` re-points at `POST /internal/token`
  (`TOKEN_MINT_URL` + `CELL_SECRET`); the app key never lives in a cell.
- Handoff-token session creation; no GitHub OAuth callback in cells.
- `auto_stop`/`suspend` when idle (≤2 GiB RAM → sub-second resume); a cell
  sleeps when nobody is editing. Idle tenant ≈ volume cost.
- Off-boarding: uninstall → suspend → grace (snapshot to cold storage) →
  destroy volume. Per-tenant EU region at provision time. Clean GDPR deletion.

### How "which user in which org" is answered

- **Routing (control plane, cached, TTL):** `GET /user/installations` at login
  → `user → [installation_ids]`. Includes org-membership AND collaborator
  access. Just a routing hint, not a security boundary.
- **Authorization (cell, per repo):** installation token +
  `collaborators/{username}/permission` (ADR 0001). Control plane routes; the
  cell authorizes and fails closed. A stale routing hint cannot grant access.

## The load-bearing rules (from the adversarial review — do not skip)

**Blocker T — degraded mode must be explicit.** Token and authz caches are
in-memory today; auto-stop kills them. Persist the last installation token
(encrypted) and last-known permission answers in the cell's SQLite so a woken
cell serves existing users during a control-plane blip; refresh proactively at
~30 min; make the mint endpoint redundant. SLO: an N-minute control-plane
outage must not disconnect active editors or lock out live sessions.

**Blocker W — webhooks are lossy; the reconciler is the truth.** GitHub does
NOT auto-retry failed deliveries. A missed `installation.created` = a paying
customer never provisioned. Reconcile by polling `GET /app/installations`;
replay `GET /app/hook/deliveries` on recovery; keep the cells' existing
pull-based self-heal (`requestSync` on `/setup/installed` and `?refresh`).

**Blocker U — per-cell SQLite needs a rollback path.** Introduce
`PRAGMA user_version` schema versioning with expand/contract (version N+1 stays
readable by N); deploy by image **digest**; volume snapshot before every
migrating rollout; canary tenants first; orchestrator records image digest +
schema version per tenant in the directory.

**Major — `kill_timeout`.** Fly SIGKILLs 5 s after SIGTERM; our flush allows
itself 8 s. Set `kill_timeout = 30` in the cell fly.toml (fixed already, ADR-
independent — it's a live data-loss bug today). Emit a "flush complete" metric
and alert on exit without it.

**Major — durability.** A Fly volume is one NVMe slice on one host (daily
snapshots, ~5-day retention). Stream-replicate each cell's live.db off-host
(Litestream → Tigris/S3, per-tenant prefix); workspaces are reconstructible
from lineages + a fresh clone. Provision volumes at 3–5 GB, alert at 80%.

**Major — cost floor.** A forgotten browser tab holds a websocket → machine
billed 24/7. Server-side idle disconnect after N minutes without edits;
downsize cell VM; meter machine-seconds per tenant; keep a **shared cell as the
permanent free tier**, dedicated cells for paid — turns the cost floor into an
upgrade incentive.

**Major — provisioning is non-transactional.** See the state-machine +
idempotency + reconciler decision above; reinstall-during-grace must cancel the
pending destroy, not race it.

**Major — observability before ~10 tenants.** Deep `/healthz` (SQLite write,
disk free, token freshness); logs to one sink tagged by tenant; fleet dashboard
from the directory; alerts (unhealthy-while-subscribed, mint failures,
provisioning stuck, disk >80%, exit without flush); one synthetic canary tenant
probing login→edit→release hourly.

**Fly specifics (verified):** `fly-replay` can't replay bodies >1 MB → large
uploads (import-process) go direct-to-cell via `<cell>.fly.dev` or to object
storage. Idle cells are unreachable over plain 6PN (`.internal` only resolves
started machines) → forward webhooks via **Flycast** (routes through the proxy,
auto-starts). Optionally isolate each cell on its own custom private network.
Get Fly's per-org app quota (~20 default) raised before launch. Keep service
concurrency type `connections` (not `requests`) so websockets keep cells awake.

**Security nuance:** by default all apps in a Fly org share one 6PN network — a
compromised cell can reach other cells' ports. Either per-cell custom networks,
or require the per-cell secret on every internal endpoint. The app key and
other tenants' tokens are never exposed (they live only in the control plane).

## Implementation status (2026-07-11)

Built + tested offline (no GitHub, no Fly, no Stripe):

- **Phase 1 — cell-ification:** done (tenant filter, app-side authz, TokenService
  local/remote + degraded-mode persistence, handoff login).
- **Phase 2 — control plane:** token minting (derived per-cell secrets), OAuth
  login + `/user/installations` discovery + handoff, webhook receiver **+
  forwarding to cells** (re-signed per-cell), reconciler diff, **provisioner
  state machine** (Fly Machines `FlyProvisioner` env-gated + `FakeProvisioner`;
  `driveReconcile` idempotent + retry-safe) and a **reconciler loop**
  (`RECONCILE_INTERVAL_MS`).
- **Phase 3 — auth-model migration:** done — **bot-authored releases** (ADR
  0001), zero stored user tokens end to end.
- **Phase 4 — ops:** deep `/healthz` (SQLite write + disk) on cell + control
  plane. Litestream / fleet dashboard / synthetic canary: not yet.
- **Phase 5 — commerce:** onboarding "setting up your workspace" page +
  `/api/tenant-state`; plan per tenant + entitlements map; Stripe webhook seam
  with real signature verification, **inert without `STRIPE_WEBHOOK_SECRET`**.

**Needs live infrastructure before it runs (code complete, not activated):**
`FlyProvisioner` (needs `FLY_API_TOKEN` + a published `CELL_IMAGE` + raised Fly
app quota), managed Postgres (SQLite directory is the skeleton backend),
Litestream backup, the Stripe integration (price→plan mapping is a pricing
decision), and the production GitHub App key handling (security gate). The
full offline E2E (`apps/control-plane/test/e2e.sh`) exercises the wire.

## Phased migration (reordered after review)

- **Phase 0 (today):** the running instance IS the shared cell. Define the
  exit recipe now: a tenant with no live docs and a clean (fully released)
  workspace migrates by provisioning a fresh cell and reseeding lineages from
  git (the reconcile/dropState mechanism already embodies this). Tooling blocks
  migration while live docs or dirty diffs exist.
- **Phase 1 — cell-ification (small, testable against today's image):**
  `TENANT_INSTALLATION_ID` filter, token-mint client, handoff-token login.
  Everything env-gated: with no new env, the cell behaves exactly as today.
- **Phase 2 — control-plane MVP:** directory (managed PG), provisioner state
  machine, reconciler, router, redundant token minting.
- **Phase 3 — auth-model migration (own milestone, ADR 0001):** drop
  `provider_token`, installation-token authz, bot-authored releases +
  attribution; grow the release-e2e harness a bot-authored variant first.
- **Phase 4 — ops:** deep health, log sink, fleet dashboard, canary probe,
  Litestream.
- **Phase 5 — commerce:** Stripe, entitlements, self-service onboarding
  ("setting up your workspace" page polls cell health, then redirects).

## Consequences

- Hard isolation per tenant (process, filesystem, DB, network optional),
  clean deletion, per-region residency — strong enterprise/GDPR posture.
- Cost scales with _activity_, not tenant count; free tier is feasible via a
  shared cell.
- The control plane becomes availability-critical for minting/login/webhooks;
  its degraded-mode obligations (blocker T) are non-negotiable.
- More moving parts than a monolith: a provisioner state machine, a reconciler,
  fleet upgrade orchestration and observability are now first-class components,
  not afterthoughts.
- Everything in Phase 1 is additive and env-gated, so the cell code can ship
  and keep running as the single shared instance until the control plane is
  ready.
