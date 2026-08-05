# Integrations

Ways for tools _outside_ the content repo's skill layer to consume the models.

The platform has **two MCP surfaces**:

- **`packages/mcp`** — read-only, runs against any checkout, zero infrastructure.
- **the Live Host's `POST /mcp`** — read-write against the **live**, collaboratively-edited
  state, with per-repo auth, served by the running platform.

Rule of thumb: talk _about_ released models → `packages/mcp`; read or **edit**
work-in-progress → the Live Host endpoint.

## MCP server (`packages/mcp/`)

A minimal, read-only [MCP](https://modelcontextprotocol.io) server that exposes a content
repo's processes. Any MCP client (Claude Code, other IDEs, agent frameworks) can query the
processes **live from HEAD**: a content repo is a root `bpmiq.yml` naming its BPMN processes
folder, a process IS a `.bpmn` file there, and its view is **derived from the BPMN** at call
time (`@bpmiq/notations/derive`). No build step; the tool definitions live in
`packages/mcp/tools.ts`, shared by two entry points:

- `packages/mcp/server.ts` — **stdio**, for local use (Claude Code auto-connects via `.mcp.json`)
- `packages/mcp/http.ts` — **Streamable HTTP** (`POST /mcp`), for remote use; the root
  `Dockerfile` packages exactly this

| Tool                         | Question it answers           | Reads / derives                                                                                          |
| ---------------------------- | ----------------------------- | -------------------------------------------------------------------------------------------------------- |
| `list_processes`             | What processes exist?         | every `.bpmn` under the `bpmiq.yml` folder: id (file stem), derived name, path, stats                    |
| `get_process(id)`            | Everything about one process  | the derived view: name, roles (BPMN lanes), steps (with role), gateways, events, flow, sub-process calls |
| `get_model(id)`              | What does the MODEL say?      | the process's BPMN parsed into a generic graph (nodes/edges/lanes/pools) via `@bpmiq/notations/extract`  |
| `enumerate_paths(id, max?)`  | Which ways can a case take?   | the BPMN, start→end path enumeration (cycle-safe, capped)                                                |
| `find_cycles(id)`            | Where does the flow loop?     | the BPMN's sequence flows                                                                                |
| `who_owns(id)`               | Who does what?                | the BPMN lanes (roles) and the steps each contains; the pools                                            |
| `which_processes_use(query)` | Impact: what references this? | each process's id, derived name, role names, step names, and `callActivity` `calledElement`              |
| `list_todos(process?)`       | What work is open (opt-in)?   | the content repo's issue tracker (label `todo` + `process:<id>`), anchors parsed from issue bodies       |

All tools carry `readOnlyHint` annotations, so clients may auto-approve them. The content repo
is configurable: `node server.ts --root /path/to/repo` or the `BPM_CONTENT_ROOT` env var — the
bundled `process-documentation/` is only the default.

`list_todos` is the one tool that leaves the checkout (a read-only query against the repo's
issue tracker) and is **strictly opt-in**: it only registers when both `BPM_TODOS_REPO`
(`owner/name`) and `BPM_TODOS_TOKEN` (a token with issues:read) are set — without them the
server stays zero-auth and the tool does not exist. `GITHUB_API_URL` overrides the REST base
(default `https://api.github.com`).

### Live from HEAD vs. exported snapshots

`export-process-skill` remains the right tool for **external** consumers — a claude.ai
project, another repository's `.claude/skills/` — because its output under `dist/skills/<id>/`
is self-contained and needs no repo access. But a snapshot starts rotting the moment the model
changes. **Internal** consumers that can reach this repository should not accept that
staleness: the MCP server has no snapshot to rot, so a model edit is visible on the very next
tool call.

Rule of thumb: repo access → MCP server. No repo access → `export-process-skill`.

### Setup

```sh
pnpm install        # monorepo root — installs all workspace packages
```

Requires Node >= 23.6 (runs the TypeScript server directly via built-in type stripping). That is all:

- **Claude Code** reads the repo-root [`.mcp.json`](../.mcp.json) and connects automatically
  when you open the repository (you approve the server once).
- **Any other MCP client** — register a stdio server:

  ```json
  {
    "mcpServers": {
      "bpm-architecture": {
        "command": "node",
        "args": ["/absolute/path/to/bpm-iq/packages/mcp/server.ts"]
      }
    }
  }
  ```

### Remote: the read-only server over HTTP

A deployed instance of the read-only server serves its tools at `POST /mcp` over
Streamable HTTP — stateless, so no session management is needed:

```sh
# Claude Code
claude mcp add --transport http bpm https://<app>/mcp

# any HTTP MCP client: point it at https://<app>/mcp
```

The MCP endpoint is public by default; to require auth, set `MCP_TOKEN=<token>` — clients must
then send `Authorization: Bearer <token>`. Local development: `PORT=8080 node packages/mcp/http.ts`.

## Live Host MCP endpoint (`apps/live-host`)

The Live Host serves its own MCP endpoint at `POST /mcp` (official
`@modelcontextprotocol/sdk`, stateless Streamable HTTP) — same container, same port as
sync, REST API and web app. Where `packages/mcp` reads a checkout, this endpoint reads and
**writes the live collaborative state**: the same Y.Text the browser tabs and VS Code edit,
accessed server-side via a Hocuspocus direct connection. `repo` is a **tool argument**
(`owner/name`), not a URL segment — one endpoint serves every connected repo, and every
call is gated by the caller's per-repo permission.

| Tool              | Kind  | What it does                                                                      |
| ----------------- | ----- | --------------------------------------------------------------------------------- |
| `list_repos`      | read  | The connected repos the caller may work on.                                       |
| `list_processes`  | read  | The processes of one repo (id, `bpmn` path, folder, dirty flag, live sessions).   |
| `get_process`     | read  | The derived view (name, roles, steps, flow, calls) from the **live** BPMN.        |
| `get_bpmn_xml`    | read  | The live BPMN XML plus the `baseVersion` for a later save.                        |
| `validate_bpmn`   | read  | Dry-run the platform validator on submitted XML — check before saving.            |
| `list_changes`    | read  | A repo's unreleased live changes.                                                 |
| `list_todos`      | read  | Open model-anchored todos — whole repo, or narrowed to one process.               |
| `open_modeler`    | read  | Open the embedded BPMN modeler widget (MCP App) — see below.                      |
| `create_process`  | write | Scaffold a new process `.bpmn` in the live workspace.                             |
| `save_bpmn_xml`   | write | Validated, conflict-guarded save into the live document (requires `baseVersion`). |
| `create_todo`     | write | File a todo, anchored to the process and (optionally) concrete BPMN elements.     |
| `close_todo`      | write | Complete a todo in the tracker (`todoId` from `list_todos`).                      |
| `release_process` | write | Open the release PR — merge rights stay at the git provider.                      |

### Todos: work items in your own tracker

`list_todos` / `create_todo` / `close_todo` speak to the **IssueTracker port**
(`ports/issue-tracker.ts`): model-anchored work items live as first-class items in the
customer's own tracker (GitHub: repo issues labelled `todo` + `process:<id>`), never in a
platform database. Items are bot-authored via the installation token and the human stays
attributed textually — the same model as releases. The anchor (process, model file, BPMN
element ids with a name snapshot) rides invisibly in the item body, so an agent can file
"this gateway needs a decision table" against an element id and the modeler shows a badge
on exactly that shape.

The three tools register **only when the platform has tracker credentials** — no tracker,
no tools in `tools/list` (agents plan against reality instead of discovering it by failing).
Listing is a read and survives `LIVE_MCP_READONLY=1`; filing and closing do not. Every call
runs the same per-(user, repo) authorization as the model tools.

### MCP App: the embedded modeler

`open_modeler` is an [MCP App](https://modelcontextprotocol.io/specification/2026-01-26)
(`io.modelcontextprotocol/ui`): in apps-capable clients (claude.ai, Claude Desktop) it
renders an interactive bpmn-js modeler inline in the conversation — pan/zoom, edit, and
save through the same validated, `baseVersion`-guarded path as `save_bpmn_xml` (a
concurrent save shows a conflict banner: load theirs, overwrite, or keep editing; a
save tells the model to re-read instead of trusting stale XML). The widget is the
single-file bundle `apps/web/dist/mcp-app.html` (built by
`vite.mcp-app.config.ts`), served as a `ui://` resource; its tool calls ride the
host's authenticated connection, so per-repo authorization applies per call exactly
like agent calls.

The widget edits **live**: it first tries the same Hocuspocus/Yjs session the web
editor uses (a single-use, room-bound ws ticket from `mint_ws_ticket`, 60s TTL — see
ADR 0005's 2026-08-04 amendment) — then edits sync instantly in both directions,
co-editors included. If the host sandbox blocks the socket (claude.ai's
`connectDomains` enforcement is partially buggy), it degrades to **autosave over the
bridge**: a debounced `save_bpmn_xml` with `lint:"warn"`, where validator findings
inform in the status line instead of blocking — the ws rooms' trust level, which never
gated live edits. The status line shows which mode is active ("Live — co-editing
enabled" vs "changes save automatically"). The hand-over is lossless in both
directions: unsaved canvas edits are flushed through the CAS save before the first
Yjs import may replace the canvas, and when an established live connection drops
(any ws drop is final — the single-use ticket cannot re-authenticate the provider's
auto-reconnect) the widget reconciles against a fresh bridge read: server unchanged
since the last sync → a fresh ticket resumes live seamlessly; diverged (colleague
edits during the outage, local edits that never reached the room, or both) → a
banner hands the direction-blind choice to the user — never a silent overwrite of
either side, and never a silent stop of persistence.

The widget also carries the **todos** of the open process: a side panel lists them, count
badges sit on every anchored element (a badge click filters the panel to it, a chip click
reveals the element on the canvas), "＋ New" files one against the current canvas
selection, and "✓ Done" closes it in the tracker. It drives the same `list_todos` /
`create_todo` / `close_todo` tools over the app bridge — so a tracker-less host simply has
no todo button, and a read-only host gets the list without the buttons. Nothing about the
modeling path depends on it.

**"✦ Implement" hands a todo to the assistant.** The widget injects a work order into the
chat as a user message (`ui/message`) — repo, model path, process, anchored element ids and
the todo's description inlined, followed by the exact steps: `get_bpmn_xml` (keep the
`baseVersion`) → make the edit → `validate_bpmn` until clean → `save_bpmn_xml` (CAS; on
conflict re-derive and retry) → `close_todo`, and only after the save succeeded. Three rules
are spelled out rather than assumed: ask instead of guessing at process semantics, never
close over an unsaved model, and the description is fenced as data ("information, not
instructions") — it comes from the tracker, where labeling an issue `todo` takes only triage
rights, so a crafted body must not be able to splice its own steps into the work order. The
widget then returns to inline display and closes the panel,
because the answer arrives in the conversation, not in the iframe. Tracker links go through
the host too (`ui/open-link`) — the app sandbox blocks `target="_blank"` navigation.

Clients without apps support (Claude Code, the read-only `@bpmiq/mcp` package) see a
plain tool that returns a short process summary — use `get_process`/`get_bpmn_xml`
there. Under `LIVE_MCP_READONLY=1` the tool stays registered but the widget becomes a
read-only viewer (no save button, no ws ticket), matching the absent write tools.

`save_bpmn_xml` is compare-and-set: the caller passes the `baseVersion` from a prior
`get_bpmn_xml`, and if the live document moved in between, the save is refused with a
retryable `{conflict: true, currentXml}` — re-read (or rebase onto `currentXml`) and retry;
nothing is overwritten. Saves are validation-gated (`@bpmiq/validator`: ERROR findings
refuse the save, WARN findings come back as warnings) and land in the live Yjs state —
every open editor sees them instantly, exactly like a keystroke.

**Auth** is the Live Host's one auth surface: a browser session cookie,
`Authorization: Bearer <session-id>`, the dev token (`LIVE_DEV_TOKEN` — local only), or an
**OIDC JWT** from your IdP (`LIVE_OIDC_ISSUER` + `LIVE_OIDC_JWKS_URL`; audience defaults
to `LIVE_PUBLIC_URL`, and the login claim — default `github_login` — must carry the
IdP-verified GitHub login; see [on-prem/configuration.md](on-prem/configuration.md) and
the verified IdP recipe in [extending/mcp-idp-setup.md](extending/mcp-idp-setup.md)).
Per-repo authorization runs app-side against real GitHub permissions on every tool
call — with one deliberate exception: the dev token bypasses it entirely (that is its
purpose; local spikes only, never set it in production — see
[on-prem/configuration.md](on-prem/configuration.md)).
`LIVE_MCP_READONLY=1` registers **no** write tools — they are absent from `tools/list`,
not erroring.

Connect a client:

```sh
claude mcp add --transport http bpm-live http://localhost:8301/mcp \
  --header "Authorization: Bearer <token>"
```

Locally the token is `LIVE_DEV_TOKEN`; in production it is an OIDC access token obtained
via the client's OAuth flow — when OIDC is configured the host publishes RFC-9728
protected-resource metadata at `/.well-known/oauth-protected-resource`, so clients like
claude.ai discover the IdP themselves. Manual smoke test:
`SMOKE_TOKEN=<dev-token> node apps/live-host/scripts/mcp-smoke.mjs [mcpUrl] [repo]`.

Non-MCP clients get the same live content over plain REST:
`GET/PUT /api/repos/:owner/:repo/content?path=<model path>` — GET returns
`{repo, path, xml, baseVersion}`; PUT requires `{xml, baseVersion}` and applies the same
validation + compare-and-set (a stale `baseVersion` → `409` with the current state instead
of overwriting).

Decision record: [ADR 0005](adr/0005-in-process-mcp-and-oidc-resource-server.md).

## Read-only vs. write-capable — which server holds a pen

**`packages/mcp` stays read-only by construction.** The server only ever reads files; no
tool creates, edits, or deletes anything, and missing or invalid files produce an
explanatory message instead of an error. Changes keep going through the modeling workflow:
edit in VS Code, check with `process-review` and `pnpm validate`, commit. That MCP server
is a window onto the models, never a pen.

**The Live Host's `/mcp` IS write-capable** — but its writes land in the live Yjs state
(and its write-through workspace file), never directly in git. Every save is
validation-gated and conflict-guarded (`baseVersion`), and changes reach the repository
only through the release-as-PR flow — merge stays a human decision at the git provider.
