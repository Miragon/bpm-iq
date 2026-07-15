# Integrations

Ways for tools _outside_ the content repo's skill layer to consume the models.

## MCP server (`packages/mcp/`)

A minimal, read-only [MCP](https://modelcontextprotocol.io) server that exposes a content
repo's dependency graph. Any MCP client (Claude Code, other IDEs, agent frameworks) can
query the processes **live from HEAD**: every answer is read from `processes/*/process.yaml`
and `landscape/` at call time. No build step; the tool definitions live in
`packages/mcp/tools.ts`, shared by two entry points:

- `packages/mcp/server.ts` — **stdio**, for local use (Claude Code auto-connects via `.mcp.json`)
- `packages/mcp/http.ts` — **Streamable HTTP** (`POST /mcp`), for remote use; it also serves
  the built VitePress portal — the root `Dockerfile` packages exactly this

| Tool                         | Question it answers                                                       | Reads                                                                                                                                                               |
| ---------------------------- | ------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `list_processes`             | What processes exist, in what state?                                      | every `process.yaml`: `id`, `name`, `classification`, `status`, `version`, `owner.team`, `last_reviewed`                                                            |
| `get_process(id)`            | Everything about one process                                              | full `process.yaml` (incl. `kpis`, `operations`, `mining`, `controls`, `approval`, `history`), the model/doc file list, `docs/overview.md`                          |
| `get_model(id, file?)`       | What does the MODEL actually say?                                         | any declared model file, parsed into a generic graph (nodes/edges/lanes/pools, DMN hit policies + rules) via `@bpmiq/notations/extract` — every registered notation |
| `enumerate_paths(id, max?)`  | Which ways can a case take?                                               | the primary BPMN, start→end path enumeration (cycle-safe, capped)                                                                                                   |
| `find_cycles(id)`            | Where does the flow loop (rework/retry)?                                  | the primary BPMN's sequence flows                                                                                                                                   |
| `query_kpis(query?)`         | How is X measured, where are actuals?                                     | `kpis[]` incl. dated `actuals` across the portfolio                                                                                                                 |
| `get_landscape(view)`        | Strategy: automate/outsource? Conway mismatches? Coverage?                | `wardley-map.owm` / `team-topology.tt` / `value-chain.vc.json` as graphs                                                                                            |
| `who_owns(id)`               | Who owns it, who participates, how?                                       | `owner` + `participants` resolved against `landscape/team-topology.tt` (label, type, description)                                                                   |
| `which_processes_use(query)` | Impact: what depends on this system / component / team / step / decision? | `systems[].name`, `wardley.components[]`, team ids, `value_chain.steps[]`, `supports[]`, `related_processes[]`, `subprocesses[]`, `decisions[]`, `kpis[]`           |
| `search_glossary(term)`      | What does this word mean here?                                            | `landscape/glossary.yaml` (term, definition, synonyms)                                                                                                              |

All tools carry `readOnlyHint` annotations, so clients may auto-approve them.
The content repo is configurable: `node server.ts --root /path/to/repo` or the
`BPM_CONTENT_ROOT` env var — the bundled `process-documentation/` is only the default.

### Live from HEAD vs. exported snapshots

`export-process-skill` remains the right tool for **external** consumers — a claude.ai
project, another repository's `.claude/skills/` — because its output under `dist/skills/<id>/`
is self-contained and needs no repo access. But a snapshot starts rotting the moment someone
bumps `version` or `last_reviewed`; that is exactly why `process.yaml` tracks exports in
`published[]`. **Internal** consumers that can reach this repository should not accept that
staleness: the MCP server has no snapshot to rot, so a version bump, an ownership change, or a
new `history` entry is visible on the very next tool call.

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
        "args": ["/absolute/path/to/bpm-architecture/packages/mcp/server.ts"]
      }
    }
  }
  ```

### Remote: portal + MCP in one app

A deployed instance (example: Miragon's hosted portal <https://bpm-architecture.fly.dev>) serves the
portal at `/` and the same five tools at `POST /mcp` over Streamable HTTP — stateless, so no
session management is needed:

```sh
# Claude Code
claude mcp add --transport http bpm https://bpm-architecture.fly.dev/mcp

# any HTTP MCP client: point it at https://<app>.fly.dev/mcp
```

Every push to `main` re-validates the models and redeploys
(`.github/workflows/deploy.yml`, requires the `FLY_API_TOKEN` repo secret from
`flyctl tokens create deploy`). The MCP endpoint is public by default; to require auth, set
`flyctl secrets set MCP_TOKEN=<token>` — clients must then send
`Authorization: Bearer <token>`. The portal stays public either way. Local development:
`PORT=8080 node packages/mcp/http.ts` after `pnpm portal:build`.

### Read-only guarantee

The server only ever reads files; no tool creates, edits, or deletes anything, and missing or
invalid files produce an explanatory message instead of an error. Changes keep going through
the modeling workflow: edit in VS Code, check with `process-review` and `pnpm validate`,
commit. The MCP server is a window onto the models, never a pen.
