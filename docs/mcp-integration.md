# Integrations

Ways for tools _outside_ the content repo's skill layer to consume the models.

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

### Remote: MCP over HTTP

A deployed instance serves the tools at `POST /mcp` over Streamable HTTP — stateless, so no
session management is needed:

```sh
# Claude Code
claude mcp add --transport http bpm https://<app>/mcp

# any HTTP MCP client: point it at https://<app>/mcp
```

The MCP endpoint is public by default; to require auth, set `MCP_TOKEN=<token>` — clients must
then send `Authorization: Bearer <token>`. Local development: `PORT=8080 node packages/mcp/http.ts`.

> A **Live Host** MCP endpoint — querying the live, collaboratively-edited state with per-repo
> auth — is designed in [issue #35](https://github.com/Miragon/bpm-iq/issues/35) and not yet built.

### Read-only guarantee

The server only ever reads files; no tool creates, edits, or deletes anything, and missing or
invalid files produce an explanatory message instead of an error. Changes keep going through
the modeling workflow: edit in VS Code, check with `process-review` and `pnpm validate`,
commit. The MCP server is a window onto the models, never a pen.
