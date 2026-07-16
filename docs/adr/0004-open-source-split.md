# ADR 0004 — Open-source split: public platform monorepo, private SaaS overlay

Status: **accepted** (2026-07-15) · Scope: repository topology, licensing, artifact flow

## Context

On-premise customers want to run the platform themselves with source access, and the
roadmap's next platform capabilities — SSO session issuance, a GitLab connector — should be
built in the open against the existing ports (ADR 0003). The SaaS business (tenant
provisioning, billing, the GitHub App private key) must stay private.

The architecture already supports the cut: the control plane consumes only dependency-free
leaf packages (never the reverse, CI-enforced), the live-host runs standalone by default
(cell mode is opt-in env, ADR 0002, and holds no secrets — all per-cell secrets are derived,
the App key never reaches a cell), and mcp/vscode have zero SaaS coupling.

## Decision

### 1. Two repositories

| Repo                                                         | Contents                                                                                                                                                                                                                                                                                                                                         |
| ------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **`Miragon/bpm-iq`** (new, public, MIT)                      | `apps/live-host`, `apps/web`, `apps/vscode`, all `packages/*`, `process-documentation/` + its starter mirror workflow, root toolchain (tsconfig/eslint/prettier/dependency-cruiser/validate CI), on-prem deliverables (`deploy/` compose, `docs/on-prem/`, `docs/extending/`), release workflow publishing **`ghcr.io/miragon/bpmiq-live-host`** |
| **`Miragon/bpm-iq-cloud`** (existing, private, full history) | `apps/control-plane` (+`ui`), `packages/cp-contracts`, the Fly deploy chain (`deploy.yml`, both `fly.toml`s), SaaS runbooks (`apps/control-plane/docs/`); consumes the public repo as git submodule **`vendor/bpmiq/`**                                                                                                                          |

The public repo is the **source of truth** for everything it contains; day-to-day platform
development happens there. The private repo is a thin overlay, never a fork.

### 2. Public history is a fresh start

The public repo begins with a single "Initial public release" commit. The pre-split history
(117 internal commits: SaaS ops material, internal-audience commit messages, one personal-path
leak) stays in the private repo; the export point is tagged there (`public-cutover-v0.1.0`).
Gate before the first public push: `gitleaks detect --no-git` + manual docs review.

### 3. The private repo consumes shared packages via submodule, not npm

The private side needs six public packages (`cell-protocol`, `contracts`, `http-kit`,
`github-app` for the backend; `api-client`, `ui-kit` for the operator SPA — plus `cp-contracts`
locally). The private `pnpm-workspace.yaml` globs those six paths inside `vendor/bpmiq/`
individually. pnpm symlinks them into `node_modules`, so their realpath stays outside
`node_modules` and Node's type stripping keeps working — npm-publishing raw-`.ts` packages
would not (Node refuses to strip `.ts` under a `node_modules` realpath), and a build step is
exactly what ADR 0003 avoids. The submodule gitlink doubles as an exact, reviewable version pin.

### 4. Cell mode ships in the open code

The env-gated SaaS plumbing in the live-host (handoff login, remote token minting,
`cell-protocol`) stays in the public codebase — one codebase, no fork drift; without a control
plane it is inert, and it contains no secret material by design. Consequently ADRs 0001–0003
are public too (they explain code that ships). The control-plane ↔ operator-SPA wire types are
the one exception: they moved from `@bpmiq/contracts` into the private `@bpmiq/cp-contracts`
so private SPA features never require a public-repo PR.

### 5. One artifact: the GHCR image

The public release workflow publishes `ghcr.io/miragon/bpmiq-live-host` (`sha-<short>` per
main push; `vX.Y.Z` + `latest` on tags). The private deploy no longer builds the live-host: it
deploys `bpm-live` from the GHCR tag matching its submodule SHA and pins `CELL_IMAGE` to the
same reference. On-prem installations, `bpm-live`, and every SaaS cell run the identical
artifact, and the previous "read back whatever bpm-live is running" indirection disappears —
cell image, deployment, and control-plane code all derive from one reviewed submodule bump.

## Consequences

- On-prem customers get the full self-hostable platform (server + web + vscode + mcp +
  validator) under MIT; SSO and GitLab contributions land against the public ports.
- The public/private boundary becomes physical. Inside the private repo,
  `.dependency-cruiser.mjs` keeps the control-plane rules and adds: imports into
  `vendor/bpmiq/apps/` are forbidden (only the submodule's `packages/` are legal).
- Every public release triggers a submodule-bump PR in the private repo (dispatch + daily
  cron backstop) — the standing integration check; the two repos never disagree for longer
  than one bump cycle.
- Cross-repo changes (a shared-package change needed by the control plane) cost a public PR
  plus a pin bump. Accepted: the six shared packages are the platform's most stable code.
- Rollback in week one is a single `git revert` of the private rewiring PR; the public repo
  accepts only fast-follow fixes until the split has survived its first week.
