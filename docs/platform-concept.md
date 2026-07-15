# Platform Concept: Live Collaboration for the BPM Landscape

> Status: concept (2026-07-07), **revision 2 — Hocuspocus pivot**. Scope of v1: BPMN diagrams
>
> - `process.yaml` + Markdown docs. Everything TypeScript. Builds on what exists: the repo as
>   system of record, `validate.ts`, the portal, and the MCP server.
>
> **Revision 3 (2026-07-15):** the implemented client stack is React 19 + Vite + TanStack
> Router/Query + Tailwind v4 + shadcn (shared via `@bpmiq/ui-kit`/`@bpmiq/api-client`);
> the live-session wiring and the BPMN sync rules below live in `@bpmiq/live-client`;
> backend/module structure is hexagonal per
> [ADR 0003](adr/0003-module-architecture-and-shared-packages.md). The 4 sync rules in this
> document remain the authoritative design; code references to `apps/web/src/sync.ts` now
> mean `packages/live-client/src/bpmn-sync.ts`.

## Revision 2 (2026-07-07): Hocuspocus instead of OCT

An external tool evaluation recommended [Hocuspocus](https://tiptap.dev/docs/hocuspocus) over
OCT, and the M0 spike confirmed it empirically (`apps/live-host/README.md`): with OCT, the always-on
Live Host must be built as a headless _session host_ against OCT's ephemeral, E2E-encrypted
session semantics (session dies with the host, unstable room ids, seed races — all observed
in the spike); with Hocuspocus **the server is the host**: persistent room-per-document,
`onAuthenticate` (WorkOS/GitHub JWT) and `onStoreDocument` (persistence/git) are native hooks,
and the web app uses the standard Yjs provider. Round trip measured 12 ms vs. 27 ms, first-guest
sync 0 ms vs. 10 s. E2E encryption lost nothing — our own server read everything by design.

What changes against the text below: components **1 (relay) and 2 (Live Host) merge into one
Hocuspocus-based service**; rooms are per model file (matching per-process releases), not one
workspace session; the VS Code side is a **thin own extension** (`bpm-live://`
FileSystemProvider bound to Y.Text, ~150 lines — skeleton in `apps/vscode/`) instead of the
OCT plugin. Everything else — release flow, GitHub-based authorization, BPMN text-sync rules,
deployment shape, milestones — carries over unchanged. OCT stays the right choice if
developers should live-share _arbitrary_ files in VS Code; that need can be revisited without
touching this architecture. The OCT-specific sections below are kept as evaluated context.

## Vision

Today the repo is the workspace. The platform inverts that for modelers:

- **The Live Host holds the current working state.** Everyone who models — from VS Code via
  the OCT plugin or from the web app — connects to the same live session and always sees the
  latest state. Nothing is "checked out"; there is exactly one live version.
- **Git holds the released state.** A release turns the live state of _one process_ into a
  GitHub PR. Review + merge = approval (CODEOWNERS, as governed today). The pipeline
  validates, deploys portal + MCP, and tells the Live Host to rebase onto the new `main`.
- **The portal stays the read surface** for everyone else: always the last _released_ state.

```
                 ┌─────────────────────── modelers ───────────────────────┐
                 │                                                        │
        VS Code + OCT plugin                                     Web app (browser)
        (Miragon BPMN Modeler)                            bpmn-js canvas + Monaco (yaml/md)
                 │  E2E-encrypted Yjs sync (Socket.IO)             │
                 └────────────────┬───────────────────────────────┘
                                  ▼
                        ┌──────────────────┐        creates rooms, owns workspace,
                        │    OCT relay     │◄──────  serves files, persists Y.Docs
                        │  (self-hosted,   │        ┌────────────────────┐
                        │   stateless)     │───────►│     LIVE HOST      │
                        └──────────────────┘        │  headless OCT host │
                                                    │  git checkout+live │
                                                    └───┬──────────▲─────┘
                                     "release process X"│          │ rebase on merge
                                                        ▼          │ (webhook)
                                                 ┌─────────────────┴──┐
                                                 │       GitHub       │
                                                 │  PR → review → CI  │
                                                 │  (validate.ts)     │
                                                 └─────────┬──────────┘
                                                           │ deploy on merge
                                                           ▼
                                            ┌────────────────────────────┐
                                            │  Portal + MCP (fly.io)     │
                                            │  released state, read-only │
                                            └────────────────────────────┘
```

## What OCT gives us — and what it deliberately doesn't

Findings verified against the OCT source (`eclipse-oct/open-collaboration-tools`, all MIT,
all packages 0.3.x):

| OCT provides                                                                                                                                            | OCT does _not_ provide                                                                                |
| ------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| Relay server (self-hostable Docker image, port 8100, Socket.IO): auth (GitHub OAuth, API key, simple login), room registry, message routing             | **Any persistence** — rooms live in memory, content is E2E-encrypted (server cannot read it)          |
| Protocol + Yjs packages, isomorphic (Node + browser): `ConnectionProvider`, `createRoom/joinRoom`, `fs.*` file protocol, `OpenCollaborationYjsProvider` | **Sessions that survive the host** — host disconnect closes the room (30 s reconnect grace)           |
| VS Code extension (`typefox.open-collaboration-tools`): share/join, guests see the host workspace as a virtual `oct://` filesystem                      | **Sync for webview/custom editors** — only text documents are CRDT-synced                             |
| Monaco binding (`open-collaboration-monaco`) for web text editing                                                                                       | A multi-file web workspace client (binding is one editor/doc; the raw connection is the escape hatch) |

Two consequences shape the whole architecture:

1. **The Live Host must be ours.** Because OCT persists nothing and sessions die with their
   host, the "always-on latest state" requires a headless host service that creates the room,
   owns the workspace, answers file requests, holds the Y.Docs, and writes them durably. This
   is a supported pattern: `open-collaboration-service-process` hosts rooms programmatically
   (it powers the IntelliJ integration), `open-collaboration-agent` shows headless Node
   bootstrapping. The bot authenticates via OCT API-key auth.
2. **Text is the sync substrate.** All shipped OCT clients sync text documents (Y.Text per
   file path). Our models are text (BPMN XML, YAML, Markdown, OWM) — which is exactly why the
   repo-as-text decision pays off again here.

## Components (all TypeScript)

### 1. OCT relay (`open-collaboration-server`, self-hosted)

Unmodified upstream, deployed from the official image. Config: GitHub OAuth
(`OCT_OAUTH_GITHUB_*`) for humans, API key for the Live Host bot, JWT key, CORS for the web
app origin. Stateless — loses nothing on restart except transient connections.

### 2. Live Host (today: `apps/live-host/`)

A Node service, the heart of the platform:

- **Workspace = git checkout of `main` + live overlay.** On boot: clone/fetch the content
  repo, then replay persisted Yjs updates on top. The OCT room's workspace is this directory.
- **OCT bot host**: `ConnectionProvider.createRoom()` → `connect(roomToken)` →
  `peer.onJoinRequest` (admission policy, see AuthZ) → answers `fs.onReadFile/onStat/...`
  from the workspace → `OpenCollaborationYjsProvider` binds one `Y.Doc` (Y.Text per open
  file). Every applied update is appended to a per-file update log
  (`.live/<path>.yupdates`) and periodically compacted into snapshots — restart-safe, and
  the session can be re-created at any time because _we_ are the host.
- **Room lifecycle**: one long-lived room for the workspace. If the process restarts, it
  re-creates the room and publishes the new invite via its API (`GET /session`) — clients
  re-join automatically. (OCT rooms cannot be pinned to a stable id; the indirection through
  our API hides that.)
- **Release API** (`POST /release/:processId`, called from web app or VS Code command):
  1. materialize the live state of `processes/<id>/**` (+ any changed `landscape/` files the
     release explicitly includes) into a branch `release/<id>-<date>`,
  2. run the platform validator (`packages/validator`) locally — a failing release never reaches GitHub,
  3. open a PR via the GitHub App, authored on behalf of the releasing user
     (user-to-server token), so review rights and CODEOWNERS apply to a real person,
  4. report PR URL back into the session (chat message + web app toast).
- **Rebase on merge** (`POST /webhook/github`, push events on `main`): fetch, rebase the live
  overlay onto the new `main`. Files without live changes: fast-forward. Files with live
  changes: three-way text merge; on conflict, mark the file in-session (conflict banner in
  web app; the file's Y.Text gets conflict markers like git) — modelers resolve live.
- **Also serves**: presence/awareness relay is OCT's job, but the Live Host adds a tiny
  status API (who is connected, which files are dirty vs. `main`, open releases) that the web
  app renders.

### 3. Web app (today: `apps/web/`)

Vite + TypeScript SPA:

- **Join flow**: GitHub login on the OCT relay → join the room published by the Live Host.
- **Explorer**: file tree from the session (`fs.readDir`), grouped the way the portal groups
  content (processes, landscape), with dirty-vs-released markers from the Live Host API.
- **BPMN editing**: bpmn-js Modeler bound to the file's Y.Text — see sync design below.
- **YAML/Markdown editing**: Monaco bound per file (the `open-collaboration-monaco` package
  covers exactly this; multi-file needs the raw-connection escape hatch it exposes).
- **Presence**: OCT awareness → avatars per file, remote cursors in Monaco, remote-change
  highlighting on the BPMN canvas (color-flash per changed element via `bpmn-js-differ`).
- **Release button** per process → Live Host release API → shows PR link.
- **Read-only mode is the portal** (already live) — the web app links "released version"
  through to it rather than re-implementing a viewer.

### 4. VS Code

Two pieces, one of which exists:

- **OCT plugin** (`typefox.open-collaboration-tools`): join the Live Host's room; the
  workspace appears as `oct://` virtual filesystem; plain text files (yaml, md, owm) co-edit
  out of the box.
- **Miragon BPMN Modeler**: verified from its source — it is a `CustomTextEditorProvider`
  whose ground truth is the `TextDocument`; external document changes re-render the webview,
  and viewport/selection restore across re-imports is already implemented. That is the best
  possible starting position, with one caveat to validate in the spike (M0): OCT's sync
  binds _text documents_, so document edits made by the modeler propagate — but the modeler
  currently writes full-range `WorkspaceEdit`s, which would degrade Y.Text merges to
  replace-all. **Upstream fix in bpmn-modeler: write minimal diffs instead of full-range
  edits** (also improves plain undo/diff behavior, independent of this platform).

### 5. Portal, MCP, pipeline (existing — unchanged roles)

The deploy pipeline gains one step: after deploying portal + MCP, notify the Live Host
webhook. Optionally later: the MCP server gains `get_live_process` tools backed by the Live
Host, so agents can also talk about work-in-progress (clearly labeled as unreleased).

## Sync design for BPMN (v1)

Prior-art research is unambiguous: nobody has shipped operation-level CRDT-correct BPMN
co-editing in the open, and Camunda's Web Modeler retreated to canvas _locking_ in 8.9.
Text-level sync over Yjs is the pragmatic v1 — it is the only strategy that composes with
the VS Code custom text editor for free, and it is already ahead of public prior art. Four
rules make it sound (all grounded in verified bpmn-js/moddle behavior):

1. **Canonicalize at session start** (import→export through the session's pinned bpmn-js
   version) — moddle-xml serialization is deterministic per version, so after
   canonicalization, exports of unchanged elements are byte-stable and text diffs stay local
   to the actual edit. Pin one bpmn-js/moddle version across web app and VS Code webview.
2. **Minimal diffs into Y.Text, never replace-all** (diff-match-patch in one transaction) —
   replace-all destroys merge granularity and clobbers concurrent edits.
3. **Debounce remote re-imports** (~300–500 ms) with an import-suppression flag and
   string-equality guard (echo prevention via Yjs transaction origins).
4. **Validate merged XML before import** (cheap parse); on the rare interleaved-merge
   corruption, fall back to the last-good snapshot the Live Host keeps anyway.

Accepted v1 costs (the honest trade-offs): local undo history resets when remote changes
arrive (diagram-js clears the command stack on re-import), and remote keystrokes on
properties cost a full export/re-import round trip on peers. Both are fine at 2–5 concurrent
modelers per file. UX mitigations: per-element remote-change highlighting, and an optional
**soft element-lock** via awareness ("Dominik is editing this task") — advisory, not
enforced. v2 option if scale demands it: operation-level sync via `commandStack` events into
a Y.Map model — the building blocks exist, the engineering is substantial, and it can be
added behind the same Y.Doc without changing the platform architecture.

## AuthN / AuthZ

> **Status update (2026-07-08): implemented.** GitHub login with a repo-permission gate
> (write access = entry ticket), server-side sessions, releases pushed and PR'd as the
> logged-in user. Onboarding via the **GitHub App manifest flow**: `/setup` creates the app
> through GitHub's UI in one click, credentials return automatically, provider hot-registers —
> no secret copying (env credentials remain the ops/SaaS path). GitLab: deferred by decision;
> the `GitProvider` interface carries it, a full draft lives in git history (`08b6c20`).
> **Next (decided 2026-07-08): multi-repo + public app.** One instance, many
> repositories, a repo overview derived from the GitHub App's installations; gap
> analysis with milestones: `docs/multi-repo-architecture.md`.
> WorkOS remains the optional identity layer in front — the git-provider grant stays the
> authorization primitive. Details: `apps/live-host/README.md` → Authentication.

- **Identity**: GitHub OAuth everywhere (OCT relay handles login for plugin and web app).
- **Session admission**: the Live Host approves join requests against the GitHub org/team
  (allowlist policy; OCT's host-approval hook is exactly this extension point).
- **Write vs. read in the session**: v1 keeps one collaborative room (everyone who is
  admitted can edit; read-only users use the portal). OCT's room `permissions.readonly`
  exists if a read-only _live_ view becomes a requirement.
- **Release rights**: enforced by GitHub, not by us — the PR is opened as the releasing user
  via a GitHub App user-to-server token; CODEOWNERS + branch protection decide who can merge.
  The platform never needs its own permission model for the part that matters.

## Deployment

Self-hosting is documented in [docs/on-prem/](on-prem/); the images are
`ghcr.io/miragon/bpmiq-live-host` (server + web app) and the portal image (root
`Dockerfile`). Miragon's hosted operation runs the same artifacts (ADR 0004).

> **Status update (2026-07-09): implemented as TWO apps** — the Hocuspocus pivot merged
> relay + host, and the Live Host serves the web app itself:
>
> | App        | Notes                                                                                                                                                       |
> | ---------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
> | live-host  | HTTP + WebSocket on one port, **1 machine, no auto-stop, persistent volume** for the data dir (Yjs lineage + workspaces), GitHub App credentials as secrets |
> | portal+MCP | root `Dockerfile`                                                                                                                                           |

The OCT-era plan (kept as evaluated context) foresaw four apps: `bpm-oct-relay`,
`bpm-live-host`, `bpm-architecture`, `bpm-collab-web`.

The Live Host is deliberately a single writer (one workspace, one room) — no clustering
needed or wanted in v1; OCT's server doesn't cluster either. One landscape = one Live Host.

## Risks & mitigations

| Risk                                                       | Mitigation                                                                                                                            |
| ---------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| OCT is pre-1.0 (0.3.x)                                     | Pin versions; MIT license keeps the fork option; the protocol surface we use is small (room, fs, sync)                                |
| Session dies if Live Host restarts                         | We own the host: persisted Y-updates + auto room re-creation + client auto-rejoin via the session API; 30 s socket grace covers blips |
| Miragon modeler ↔ OCT text sync unproven                   | M0 spike task #1; known fix path (minimal-diff writes) is upstream work in our own plugin                                             |
| Y.Text merge can produce invalid XML in rare interleavings | Rule 4: validate + last-good fallback; soft element-locks reduce the collision window                                                 |
| OCT encrypts with AES-CBC (not AEAD)                       | Acceptable for v1 (transport is TLS anyway); track upstream                                                                           |
| Live state exists only on one volume                       | Fly volume snapshots + the update log doubles as journal; releases drain risk continuously — encourage small, frequent releases       |

## Milestones

- **M0 — Spike (1–2 weeks)**: self-host OCT relay; headless bot host that creates a room and
  serves a real checkout; join from VS Code plugin and from a minimal web page (Monaco);
  verify Miragon modeler behavior in an OCT session; measure BPMN text-sync round trip.
  _Exit criterion: two people co-edit order-to-cash.bpmn — one in VS Code, one in Monaco._
- **M1 — Live workspace**: persistence (update logs + snapshots), session API, web app with
  explorer + bpmn-js canvas (4-rule sync) + Monaco, presence/awareness.
- **M2 — Release flow**: GitHub App, per-process release (validate gate → PR → merge webhook
  → rebase), conflict UX, pipeline notification.
- **M3 — Polish**: soft element-locks, remote-change highlighting, dirty-vs-released markers
  in portal ("a newer live version exists"), MCP live tools.
- **M4 — v2 options**: operation-level BPMN sync, DMN/value-chain/team-topology canvases in
  the web app, multiple landscapes (one Live Host each).

## Assumptions & open questions

- **Write path** (question was left open): assumed _Live Host primary, direct git pushes
  allowed_ — the rebase-on-merge webhook handles both merged releases and direct pushes the
  same way. If direct pushes should be forbidden instead, branch protection makes `main`
  pipeline-only and the rebase path only ever sees released PRs; the architecture is
  identical.
- Sub-question for M2: may a release _also_ touch `landscape/` (shared files, CoE-owned)?
  Concept assumes yes, but flagged in the PR and routed to CoE via CODEOWNERS.
- Naming: "Live Host" here; product name open.
