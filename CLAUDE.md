# bpmiq — agent guide

**bpmiq** is a collaborative BPM platform: live modeling, PR-based release, and processes
that talk. It is a **pnpm monorepo**. The example content under `process-documentation/` is the
source of truth for BPM questions — **ground every answer in the models.**

## Map (pnpm workspace)

| Path                                    | What it is                                                                                                                                                                                                                                                  |
| --------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `apps/live-host/`                       | The platform server (`@bpmiq/live-host`): Hocuspocus sync + REST API + web app on one port. Multi-repo, per-(user,repo) authz, release-as-PR. Cell mode: env-gated, see ADR 0002/0004; leave unset when self-hosting.                                       |
| `apps/web/`                             | The collaborative web client (`@bpmiq/web`): bpmn-js + Monaco on a shared Y.Text, repo overview.                                                                                                                                                            |
| `apps/vscode/`                          | VS Code extension (`@bpmiq/vscode`): open `bpm-live://` model docs synced through the Live Host.                                                                                                                                                            |
| `packages/mcp/`                         | Read-only MCP server (`@bpmiq/mcp`) exposing a content repo's processes (discovered from `bpmiq.yml`, derived from BPMN) to any MCP client.                                                                                                                 |
| `packages/notations/`                   | Notation registry (`@bpmiq/notations`): one descriptor per notation (extensions, media kind, editor language). Adding a notation to the platform starts here — live-host, validator and web derive from it.                                                 |
| `packages/http-kit/`                    | Shared node:http primitives + `AppError`/`errorBody` for backend services (`@bpmiq/http-kit`, zero-dep). ADR 0003.                                                                                                                                          |
| `packages/github-app/`                  | GitHub App plumbing (`@bpmiq/github-app`, zero-dep): appJwt/loadPrivateKey + appRest/mint/paginate + `./oauth` — User-Agent per app.                                                                                                                        |
| `packages/contracts/`                   | Backend↔frontend wire types + the live-doc contract (`@bpmiq/contracts`: `CONTENT_KEY`, `roomName()`). Backends pin responses with `satisfies`; frontends re-export. Drift = tsc error.                                                                     |
| `packages/ui-kit/`                      | Shared shadcn primitives + `cn()` + `theme.css` for the SPAs (`@bpmiq/ui-kit`). Run the shadcn CLI HERE, not in the apps.                                                                                                                                   |
| `packages/api-client/`                  | `ApiError` + `api<T>()` + TanStack Query defaults for the SPAs (`@bpmiq/api-client`).                                                                                                                                                                       |
| `packages/live-client/`                 | The ONE live-session implementation (`@bpmiq/live-client`): `openLiveSession()`, minimal-diff Y.Text writer, bpmn-sync. Consumers: web, vscode, guest-test — nothing else.                                                                                  |
| `packages/validator/`                   | Platform validator (`@bpmiq/validator`): bpmiq.yml discovery + BPMN structure and BPMNDI coverage + callActivity link integrity. Runs against any checkout via `--root`; never executes content-repo code.                                                  |
| `process-documentation/`                | Example **BPM content repo** (`bpmiq.yml` + `.bpmn` + `.claude/skills`) — the MCP/validator example AND the content-repo contract mirrored to `Miragon/process-documentation-starter`. The Live Host serves any repo with a root `bpmiq.yml`, nothing else. |
| `docs/`                                 | Platform docs: `platform-concept.md`, `multi-repo-architecture.md`, `mcp-integration.md`, `on-prem/` (self-hosting), `extending/` (connectors, SSO), `adr/`.                                                                                                |
| `process-documentation/.claude/skills/` | The AI-first toolset (travels with the content repo).                                                                                                                                                                                                       |

### Inside `process-documentation/` (the example content repo)

The slim content contract: a root `bpmiq.yml` names the processes folder; a process
IS a `.bpmn` file there (id = file stem). There is NO `process.yaml`, landscape,
glossary or portal — the process view (name, roles from lanes, steps, flow,
sub-process calls) is DERIVED from the BPMN (`@bpmiq/notations/derive`).

| Path               | What it is                                                             |
| ------------------ | ---------------------------------------------------------------------- |
| `bpmiq.yml`        | The contract: `processes: processes` — names the BPMN processes folder |
| `processes/*.bpmn` | One process per file; `subprocesses/*.bpmn` linked via callActivity    |
| `.claude/skills/`  | The AI toolset (below)                                                 |

## Skills — prefer them over ad-hoc approaches

- **process-navigator** — any question about existing processes (flow, roles, calls, impact)
- **capture-process** — interview a process owner to elicit a process from tacit knowledge
- **import-process** — turn legacy docs (Visio/Word/Confluence/images) into a draft `.bpmn`
- **new-process** — scaffold a new process `.bpmn` (complete BPMNDI, lanes, callActivity links)
- **process-review** — quality gate: runs the validator, then judgment checks
- **process-feedback** — file and triage discrepancy reports (`feedback/<id>/`)
- **export-process-skill** — package a process (`.bpmn` + derived view) as a portable skill

Skills live in `process-documentation/.claude/skills/` and operate on content there —
they travel with the content repo (mirrored to `Miragon/process-documentation-starter`).

## Backend architecture (ADR 0003)

The backend is hexagonal: `domain/` (pure) · `ports/` (contracts) · `application/`
(use-cases; adapter impls only injected, never imported) · `adapters/<vendor>/` (github, git,
sqlite) · `http/` (router) · `server.ts` (the ONLY place reading env/constructing
adapters). A new connector (GitLab, Jira, …) = a new `adapters/<vendor>/` folder against the
existing ports. Boundaries are CI-enforced: `pnpm arch` (dependency-cruiser) — the PR that
moves a module deletes its grandfather exception in `.dependency-cruiser.mjs`.

## Hard rules

1. A content repo is a root `bpmiq.yml` naming its processes folder; a process is a
   `.bpmn` file there (id = file stem). After ANY model edit, run `pnpm validate`
   (or `node packages/validator/src/validate.ts --root <checkout>`) and fix errors first.
2. BPMN files need a complete BPMNDI section (every flow node, lane, pool, edge), or the
   visual editor breaks. Keep semantics (`bpmn:*`) and layout (`bpmndi:*`) in sync.
3. Modeling conventions: tasks verb+object, events object+past participle, gateways as
   questions, lanes = team/role labels.
4. A sub-process is a separate `.bpmn`; link it via `callActivity calledElement="<sub-id>"`
   (the sub-process's file stem). The validator warns on a dangling call.
5. When the user corrects a process ("that's not how we do it"), don't silently edit — file
   it via the `process-feedback` skill and triage.
6. This is a **pnpm** workspace: `pnpm install`, `pnpm --filter <pkg> …`. Never `npm`/`yarn`.
