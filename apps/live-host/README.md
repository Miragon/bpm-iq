# Live Collaboration — MVP

**Status: pitchable MVP** (2026-07-08). One `pnpm live-host` (monorepo root) runs
everything on **one port**: HTTP API + built web app + WebSocket sync share
http://localhost:8301 (Hocuspocus rides the same server via upgrade — behind Fly this is
a single TLS endpoint). The web app is a real collaborative BPMN modeler (bpmn-js canvas +
Monaco XML on one shared Y.Text, presence avatars), and **Release → PR** turns the live
state of a process into a validated GitHub pull request — merge = approval, the pipeline
redeploys portal + MCP.

Verified end to end (all self-tested, see git history for the harnesses):

- canvas co-modeling, two real browser tabs, both directions, ~370 ms: **9/9 PASS**
- release flow against the real repo: PR created, CI validate green (pre-split, private history)
- VS Code (Miragon modeler on `bpm-live://`): **6/6 PASS**
- Yjs lineage survives server restarts (SQLite persistence in `.live/live.db`): **PASS** —
  this fix came from a live-observed bug where a restart + reconnecting client duplicated
  every character of the document
- known limit (documented, accepted for MVP): text-level sync can drop one of two edits that
  collide inside the ~10 ms `importXML` window — operation-level sync is the v2 answer;
  local edits always win over remote imports (600 ms quiet period + deferred re-export)

## Multi-repo (implemented 2026-07-08)

One Live Host serves **many repositories** (docs/multi-repo-architecture.md). The connected
set derives from the GitHub App's **installations** (app JWT → installation enumeration,
webhook receiver at `POST /webhook/github`, fallback: the host's own repo when no app
private key is configured). The web app opens with a **repo overview** (`GET /api/repos`,
filtered per user permission); rooms are **`<owner>/<repo>/<path>`**; every repo gets its
own workspace (`.live/workspaces/<owner>/<repo>`, cloned on demand with installation
tokens — the host's own repo keeps using this checkout). Releases are repo-scoped
(`POST /api/repos/:owner/:repo/release/:id`) and validation always runs the PLATFORM's
validator (`packages/validator/src/validate.ts --root <workspace>`) — never code from a
content repo.
Requires in `.env` (from `pnpm create-app` in this directory): `GITHUB_APP_ID` + the app
private key — via any of (first match wins):
`GITHUB_APP_PRIVATE_KEY` (paste the raw PEM straight into `.env`, wrapped in double quotes —
multi-line is fine), `GITHUB_APP_PRIVATE_KEY_FILE=/path/to/app.pem`,
`GITHUB_APP_PRIVATE_KEY_B64` (base64 one-liner), or just drop the downloaded `.pem` into
`apps/live-host/` (auto-detected; `.env` and `*.pem` are gitignored).
(+ `GITHUB_WEBHOOK_SECRET` for live webhooks.)
Verified: 13-check browser E2E incl. same-process-id-in-two-repos isolation (no
cross-repo bleed) and per-(user,repo) authorization.

## Todos — model-anchored work items in the repo's own tracker

`GET/POST /api/repos/:fullName/todos` stores todos as **GitHub Issues in the content repo**
(label `todo` + `process:<id>`, the anchor block from `src/domain/todo-anchor.ts` embedded in
the issue body) — never in a platform database. Issues are created with the app installation
token (bot-authored, the human is attributed in the body — same model as releases); without
platform credentials the routes answer 501. Requires the GitHub App permission
**Issues: Read and write** (in the `create-app` manifest since the todo feature): apps
registered earlier must add the permission in the app settings, and **existing installations
must approve the added permission** (GitHub prompts the org owner) before todos work — until
then the API returns a clear 403 explaining exactly that.

## Authentication — the git provider's grant IS the login

Implemented target state (verified with an 11-check browser E2E against the stub provider):
**login authenticates, repos authorize.** Users log in via the git provider's OAuth grant
(session: httpOnly cookie for the API, session id as websocket token); per-(user,repo)
write permission is checked at request/room-join time (5-min cache) — the overview only
shows repos the user may work on. Releases push and open the PR **as the logged-in user** —
merge rights stay at the provider (CODEOWNERS/branch protection). Provider tokens never
leave the server (SQLite-backed sessions).

### GitHub — the Netlify/GitBook model: one vendor app, users only see GitHub

**Vendor step, once ever** (Miragon / the instance operator):
`pnpm --filter @bpmiq/live-host create-app` — a guided page creates the central
**"BPM Live" GitHub App** under the org that owns the content repo (requires being signed
in as org owner); credentials land automatically in `apps/live-host/.env`. Never touched again.

**User flow, forever after** — exactly what Netlify/GitBook users see:

1. **"Mit GitHub anmelden"** → GitHub's authorize screen → logged in.
2. Repo not connected yet? The screen offers **"Repository verbinden"** → GitHub's own
   **install picker** (choose org + repository) → GitHub finishes with
   `request_oauth_on_install` and the user lands back **logged in**.

No app creation, no tokens, no secrets for users. The gate stays: write permission on the
content repository (checked via the user's effective permissions) is the entry ticket, and
releases push + open PRs as the logged-in user. Verified with a 10-check browser E2E
including the full connect loop, plus an E2E of the vendor script itself.

Decision history: a per-instance app wizard and a per-user PAT login were both built,
verified, and discarded (git history) — the central-app model is what the familiar SaaS flow
actually is. `GITHUB_BASE_URL`/`GITHUB_API_URL` still point everything at GitHub Enterprise
or `test/stub-provider.ts` (offline).

### GitLab — architecture carries it, implementation deferred

The `GitProvider` interface models the four capabilities a provider needs (identity,
repo-permission gate, push URL, PR/MR creation); token login maps 1:1 onto GitLab personal
access tokens. A full GitLab draft exists in git history (`08b6c20` era).

### WorkOS (optional identity layer — by design NOT a replacement)

WorkOS AuthKit can sit in front for enterprise SSO (_who you are_), but repository
authorization always requires the git provider's own grant (_what you may release_) — that
grant is what the `GitProvider` interface models, and it is the actual entry ticket. Wiring
WorkOS in means: authenticate the person via WorkOS first, then link the git-provider grant
to that identity. Clean seam: session issuance (`SessionStore`, `src/adapters/sqlite/sessions.ts`)
is independent of the provider handshake.

### Headless clients & offline demos

- `LIVE_DEV_TOKEN=<token>` grants a bot session for tests and the VS Code extension (which
  gets its own OAuth device flow later). With no provider configured, it defaults to `demo`
  (local spike mode); once a provider is configured it is **off unless set explicitly**.
- `test/stub-provider.ts` fakes GitHub's OAuth+REST endpoints (plus a `_control` endpoint for
  the permission gate) — full login/release flow without internet, also used by the E2E.

---

## Original M0 spike notes (Hocuspocus)

Proves the core of [the platform concept](../docs/platform-concept.md) after the
**Hocuspocus pivot** (see the concept's revision note): the Live Host is a Hocuspocus server —
sync server and workspace service in one process, the server _is_ the host. One Y.Doc per
model file, room name = repo-relative path, Y.Text field `content`.

**Exit criterion (met, twice): two clients co-edit `order-to-cash.bpmn` through the Live Host.**

## Why Hocuspocus (spike evidence)

The same four-assertion test ran against both candidate stacks:

|                         | OCT + headless bot host                                 | **Hocuspocus (chosen)**                                      |
| ----------------------- | ------------------------------------------------------- | ------------------------------------------------------------ |
| initial sync            | 10 014 ms first guest (seed race, saved by 10 s resync) | **0 ms** — `onLoadDocument` seeds before the sync response   |
| co-edit round trip      | 27 ms                                                   | **12 ms**                                                    |
| write-through           | 285 ms (own debounce)                                   | 2 002 ms (built-in `onStoreDocument` debounce, configurable) |
| processes needed        | relay + bot host                                        | **one server**                                               |
| persistence, auth hooks | built by us against session semantics                   | **native hooks** (`onAuthenticate`, `onStoreDocument`)       |
| VS Code side            | extension for free (but no custom-editor sync)          | thin own extension (~150 lines, `apps/vscode/`)              |

OCT remains the right tool if developers should live-share _arbitrary_ workspace files;
for "web modeler + live model access from VS Code" the server-authoritative model wins.
The OCT variant is preserved in git history (the pre-monorepo spike tree).

## Run it

Prerequisites: Node ≥ 23.6, pnpm.

```bash
pnpm install                     # monorepo root

# Terminal 1 — the Live Host (HTTP + WebSocket on http://localhost:8301)
pnpm live-host

# Terminal 2 — automated exit-criterion test (two headless guests)
pnpm --filter @bpmiq/live-host test:sync

# Web client (dev server with hot reload; the Live Host serves the built app)
pnpm web:dev                     # http://localhost:5173
```

## Measured results (2026-07-07, localhost)

```
PASS  initial sync matches disk — alice 0ms, bob 0ms
PASS  co-edit round trip alice→server→bob: 12ms
PASS  live host persisted to the working tree after 2002ms (hocuspocus debounce)
PASS  reverse-direction edit synced and persisted — working tree clean
```

## Self-tested end to end (2026-07-07)

**Browser E2E** (Playwright, two real Chromium tabs + one headless guest):

```
PASS  two browser tabs joined and loaded the BPMN content
PASS  tab1 keyboard edit visible in tab2 after 1ms
PASS  headless guest received the browser edit
PASS  node-guest edit visible in both tabs after 4ms
PASS  both edits persisted to the working tree
PASS  cleanup synced everywhere, working tree clean
```

(Remote-cursor DOM decorations were not asserted: Monaco virtualizes lines, so a cursor
outside the viewport has no DOM node — content sync and awareness are what matter.)

**VS Code E2E** (`pnpm test:e2e` in `apps/vscode/` — real VS Code via
@vscode/test-electron, Miragon BPMN Modeler v1.3.0 installed into the test instance):

```
PASS  virtual document content equals working tree
PASS  remote edit auto-applied to open document after 50ms
PASS  local edit+save reached the remote guest after 0ms
PASS  Miragon BPMN Modeler opened the bpm-live:// document (custom-editor tab active)
PASS  remote edit propagated while the custom editor is open
PASS  cleanup: working tree clean
```

The concept's load-bearing assumptions are hereby verified programmatically: VS Code
auto-reverts non-dirty virtual documents on our `FileChangeType.Changed` events, and the
Miragon custom editor opens `bpm-live://` documents and keeps receiving remote changes.
Two open observations for the eyeball test (the only thing code can't see — pixels):
the test asserts the custom-editor _tab_, not the rendered canvas, and the test log showed
one webview css load error (possibly an artifact of the sandboxed test `--extensions-dir`).

Run the eyeball test: `cd apps/vscode && pnpm compile`, F5 (or
`code --extensionDevelopmentPath=$PWD`), then _BPM Live: Open Live Model_ while the web
client is open — watch the canvas follow the browser edits.

## What's in here

| Path                | What                                                                                                                                    |
| ------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| `src/server.ts`     | The Live Host: Hocuspocus with `onAuthenticate`, `onLoadDocument` (seed from working tree), `onStoreDocument` (debounced write-through) |
| `src/guest-test.ts` | Two headless guests: connect, co-edit, measure, revert                                                                                  |
| `../web/`           | Browser client: bpmn-js + Monaco + `HocuspocusProvider` + y-monaco (remote cursors via awareness)                                       |
| `../vscode/`        | Thin extension skeleton: `bpm-live://` FileSystemProvider bound to the shared Y.Text                                                    |

## Spike shortcuts (M1 turns these into the real thing)

- Auth = shared token; M1: WorkOS/GitHub JWT in `onAuthenticate`, user context into awareness.
- Write-through targets the developer checkout; M1: dedicated clone + debounced commits onto
  the tenant's draft branch, release flow (M2) unchanged from the concept.
- VS Code `writeFile` replaces the full Y.Text and remote updates rely on VS Code re-reading
  non-dirty files; M1: minimal-diff writes + `WorkspaceEdit`-based live binding for open
  documents (the pattern OCT's extension uses, verified in its source).
- The web client binds Monaco (text). The bpmn-js canvas with the concept's four sync rules
  is the first M1 deliverable — it binds to the same Y.Text.
