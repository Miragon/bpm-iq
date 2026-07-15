# bpmiq — agent guide

**bpmiq** is a collaborative BPM platform: live modeling, PR-based release, and processes
that talk. It is a **pnpm monorepo**. The example content under `process-documentation/` is the
source of truth for BPM questions — **ground every answer in the models.**

## Map (pnpm workspace)

| Path                                    | What it is                                                                                                                                                                                                                   |
| --------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `apps/live-host/`                       | The platform server (`@bpmiq/live-host`): Hocuspocus sync + REST API + web app on one port. Multi-repo, per-(user,repo) authz, release-as-PR. Cell mode: env-gated, see ADR 0002/0004; leave unset when self-hosting.        |
| `apps/web/`                             | The collaborative web client (`@bpmiq/web`): bpmn-js + Monaco on a shared Y.Text, repo overview.                                                                                                                             |
| `apps/vscode/`                          | VS Code extension (`@bpmiq/vscode`): open `bpm-live://` model docs synced through the Live Host.                                                                                                                             |
| `packages/mcp/`                         | Read-only MCP server (`@bpmiq/mcp`) exposing a content repo's process graph to any MCP client.                                                                                                                               |
| `packages/notations/`                   | Notation registry (`@bpmiq/notations`): one descriptor per notation (extensions, media kind, editor language). Adding a notation to the platform starts here — live-host, validator and web derive from it.                  |
| `packages/http-kit/`                    | Shared node:http primitives + `AppError`/`errorBody` for backend services (`@bpmiq/http-kit`, zero-dep). ADR 0003.                                                                                                           |
| `packages/github-app/`                  | GitHub App plumbing (`@bpmiq/github-app`, zero-dep): appJwt/loadPrivateKey + appRest/mint/paginate + `./oauth` — User-Agent per app.                                                                                         |
| `packages/contracts/`                   | Backend↔frontend wire types + the live-doc contract (`@bpmiq/contracts`: `CONTENT_KEY`, `roomName()`). Backends pin responses with `satisfies`; frontends re-export. Drift = tsc error.                                      |
| `packages/ui-kit/`                      | Shared shadcn primitives + `cn()` + `theme.css` for the SPAs (`@bpmiq/ui-kit`). Run the shadcn CLI HERE, not in the apps.                                                                                                    |
| `packages/api-client/`                  | `ApiError` + `api<T>()` + TanStack Query defaults for the SPAs (`@bpmiq/api-client`).                                                                                                                                        |
| `packages/live-client/`                 | The ONE live-session implementation (`@bpmiq/live-client`): `openLiveSession()`, minimal-diff Y.Text writer, bpmn-sync. Consumers: web, vscode, guest-test — nothing else.                                                   |
| `packages/validator/`                   | Platform validator (`@bpmiq/validator`): schema, link integrity, BPMN/DMN structure, governance, export freshness. Runs against any checkout via `--root`; never executes content-repo code. Holds the canonical `schemas/`. |
| `process-documentation/`                | Example **BPM content repo** + VitePress portal (`process-documentation`). This is the content contract the platform serves.                                                                                                 |
| `docs/`                                 | Platform docs: `platform-concept.md`, `multi-repo-architecture.md`, `mcp-integration.md`, `on-prem/` (self-hosting), `extending/` (connectors, SSO), `adr/`.                                                                 |
| `process-documentation/.claude/skills/` | The AI-first toolset (travels with the content repo).                                                                                                                                                                        |

### Inside `process-documentation/` (the content repo)

| Path                 | What it is                                                                                                             |
| -------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| `landscape/`         | Level 1: `value-chain.vc.json`, `wardley-map.owm`, `team-topology.tt`, `glossary.yaml`                                 |
| `processes/<id>/`    | One process: `process.yaml` (metadata + links), `<id>.bpmn`, `subprocesses/`, `decisions/` (DMN), `feedback/`, `docs/` |
| `processes/INDEX.md` | Portfolio overview — keep in sync when adding processes                                                                |
| `templates/process/` | Scaffold for new processes — copy, don't reinvent                                                                      |
| `dist/skills/`       | Generated process-skill exports — never edit by hand, always re-export                                                 |
| `.vitepress/`        | Portal: `pnpm portal:dev` — renders all models live via bpmn-js/dmn-js/Miragon renderers                               |
| `docs/`              | method, modeling-conventions, process-metadata, governance, migration, automation                                      |

## Skills — prefer them over ad-hoc approaches

- **process-navigator** — any question about existing processes (flow, owners, rules, KPIs, impact)
- **capture-process** — interview a process owner to elicit a process from tacit knowledge
- **import-process** — turn legacy docs (Visio/Word/Confluence/images) into draft models
- **new-process** — scaffold a new process directory correctly
- **process-review** — quality gate: runs the validator, then judgment checks
- **strategy-alignment** — automation/sourcing candidates, Conway mismatches, coverage gaps
- **process-performance** — compare models against event-log reality, maintain KPI actuals
- **process-feedback** — file and triage discrepancy reports (`process-documentation/processes/<id>/feedback/`)
- **export-process-skill** — package a process + resolved dependencies as a portable skill

Skills live in `process-documentation/.claude/skills/` and operate on content there — they
travel with the process-documentation starter (mirrored to `Miragon/process-documentation-starter`).

## Backend architecture (ADR 0003)

The backend is hexagonal: `domain/` (pure) · `ports/` (contracts) · `application/`
(use-cases; adapter impls only injected, never imported) · `adapters/<vendor>/` (github, git,
sqlite) · `http/` (router) · `server.ts` (the ONLY place reading env/constructing
adapters). A new connector (GitLab, Jira, …) = a new `adapters/<vendor>/` folder against the
existing ports. Boundaries are CI-enforced: `pnpm arch` (dependency-cruiser) — the PR that
moves a module deletes its grandfather exception in `.dependency-cruiser.mjs`.

## Hard rules

1. `process.yaml` references must resolve — after ANY model or metadata edit, run `pnpm validate`
   (or `node packages/validator/src/validate.ts --root <checkout>`) and fix errors before finishing.
2. BPMN files need a complete BPMNDI section (every flow node), or the visual editor breaks.
   Keep semantics (`bpmn:*`) and layout (`bpmndi:*`) in sync.
3. Follow `process-documentation/docs/modeling-conventions.md`: tasks verb+object, events
   object+past participle, gateways as questions, lanes = team labels, canonical glossary terms,
   rules in DMN.
4. File extensions drive the custom editors: `.bpmn`, `.dmn`, `.owm`, `.vc.json` (compound
   suffix required), `.tt`. Never rename model files to generic `.json`/`.xml`.
5. Semantic model change ⇒ bump `version` + add a `history` entry. An `as-is` process needs an
   `approval` block matching the version — changes invalidate it until re-approved
   (`process-documentation/docs/governance.md`). `last_reviewed` only moves after a human confirmed reality.
6. Exports are snapshots: after changing a process with an existing `dist/skills/<id>` or
   `published[]` entries, re-export and notify the deployments.
7. When the user corrects a process ("that's not how we do it"), don't silently edit — file it
   via the `process-feedback` skill and triage.
8. This is a **pnpm** workspace: `pnpm install`, `pnpm --filter <pkg> …`. Never `npm`/`yarn`.
