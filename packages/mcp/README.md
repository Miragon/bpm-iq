# @designiq/mcp

designIQ's read-only MCP server: it exposes a BPM content repo's processes to any MCP client
(Claude Code, Claude Desktop, IDEs, ...). A content repo is a root `designiq.yml` naming its
models folder (`models:`, legacy alias `processes:`; the legacy file name `bpmiq.yml` is still
read); a model IS a file with a registered notation extension there (a process its `.bpmn`),
and the process view — name, roles (BPMN lanes), steps, gateways, flow, and sub-process
calls — is **derived from the BPMN** on the fly. Tools:
`list_models`, `list_processes`, `get_process`, `get_view`, `get_model`, `enumerate_paths`,
`find_cycles`, `who_owns`, `which_processes_use`, `which_models_use`. Read-only by
construction: the tools only ever read files, and all of them carry `readOnlyHint`.

This server runs against a **checkout** — the right tool for CI, offline use, and any agent
with the repo on disk. For live, writable access to the collaboratively edited state of a
running Live Host, use the Live Host's own `/mcp` endpoint instead — see
[docs/mcp-integration.md](https://github.com/Miragon/design-iq/blob/main/docs/mcp-integration.md).

## Usage

```sh
# stdio server against your content repo
npx @designiq/mcp --root ./my-content-repo
```

Installed as a dependency, the same server is the `designiq-mcp-server` binary.

Or register it in an MCP client config (e.g. `.mcp.json`):

```json
{
  "mcpServers": {
    "designiq-content": {
      "command": "npx",
      "args": ["@designiq/mcp", "--root", "./my-content-repo"]
    }
  }
}
```

The content root can also be set via `DESIGNIQ_CONTENT_ROOT`. A Streamable-HTTP entry point
ships as `@designiq/mcp/http` (`PORT`, optional `MCP_TOKEN` bearer auth).

## Todos (opt-in)

The designIQ platform files model-anchored work items ("todos") as issues in the content repo's
own tracker. The `list_todos` tool exposes the open ones (id, URL, title, parsed anchor,
assignees) with an optional per-process filter — but it only registers when BOTH env vars are
set, so the zero-auth default above stays untouched (no credentials → the tool does not exist):

```sh
DESIGNIQ_TODOS_REPO=owner/name   # the tracker repo on GitHub
DESIGNIQ_TODOS_TOKEN=...         # a token with issues:read on that repo
```

`GITHUB_API_URL` overrides the REST base (default `https://api.github.com`).

The pre-rename names `BPM_CONTENT_ROOT`, `BPM_TODOS_REPO` and `BPM_TODOS_TOKEN` are still
accepted; when both names of a variable are set, the `DESIGNIQ_*` one wins.

## Part of designIQ

Source, content contract, and the example content repo live in
[Miragon/design-iq](https://github.com/Miragon/design-iq) — see
[docs/mcp-integration.md](https://github.com/Miragon/design-iq/blob/main/docs/mcp-integration.md)
for the full tool list and setup.

## License

MIT
