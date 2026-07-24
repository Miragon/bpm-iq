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
| `list_processes`  | read  | The processes of one repo (id, derived name, path).                               |
| `get_process`     | read  | The derived view (name, roles, steps, flow, calls) from the **live** BPMN.        |
| `get_bpmn_xml`    | read  | The live BPMN XML plus the `baseVersion` for a later save.                        |
| `validate_bpmn`   | read  | Dry-run the platform validator on submitted XML — check before saving.            |
| `list_changes`    | read  | A repo's unreleased live changes.                                                 |
| `create_process`  | write | Scaffold a new process `.bpmn` in the live workspace.                             |
| `save_bpmn_xml`   | write | Validated, conflict-guarded save into the live document (requires `baseVersion`). |
| `release_process` | write | Open the release PR — merge rights stay at the git provider.                      |

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
IdP-verified GitHub login; see [on-prem/configuration.md](on-prem/configuration.md)).
Per-repo authorization always runs app-side against real GitHub permissions.
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
