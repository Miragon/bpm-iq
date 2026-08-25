# @bpmiq/mcp

Read-only MCP server that exposes a BPM content repo's processes to any MCP client (Claude
Code, Claude Desktop, IDEs, ...). A content repo is a root `bpmiq.yml` naming its models
folder (`models:`, legacy alias `processes:`); a model IS a file with a registered notation
extension there (a process its `.bpmn`), and the process view — name, roles (BPMN lanes),
steps, gateways, flow, and sub-process calls — is **derived from the BPMN** on the fly. Tools:
`list_models`, `list_processes`, `get_process`, `get_model`, `enumerate_paths`, `find_cycles`,
`who_owns`, `which_processes_use`. Read-only by construction: the tools only ever read files,
and all of them carry `readOnlyHint`.

This server runs against a **checkout** — the right tool for CI, offline use, and any agent
with the repo on disk. For live, writable access to the collaboratively edited state of a
running Live Host, use the Live Host's own `/mcp` endpoint instead — see
[docs/mcp-integration.md](https://github.com/Miragon/bpm-iq/blob/main/docs/mcp-integration.md).

## Usage

```sh
# stdio server against your content repo
npx @bpmiq/mcp --root ./my-content-repo
```

Or register it in an MCP client config (e.g. `.mcp.json`):

```json
{
  "mcpServers": {
    "bpm": {
      "command": "npx",
      "args": ["@bpmiq/mcp", "--root", "./my-content-repo"]
    }
  }
}
```

The content root can also be set via `BPM_CONTENT_ROOT`. A Streamable-HTTP entry point ships
as `@bpmiq/mcp/http` (`PORT`, optional `MCP_TOKEN` bearer auth).

## Todos (opt-in)

The bpmiq platform files model-anchored work items ("todos") as issues in the content repo's
own tracker. The `list_todos` tool exposes the open ones (id, URL, title, parsed anchor,
assignees) with an optional per-process filter — but it only registers when BOTH env vars are
set, so the zero-auth default above stays untouched (no credentials → the tool does not exist):

```sh
BPM_TODOS_REPO=owner/name   # the tracker repo on GitHub
BPM_TODOS_TOKEN=...         # a token with issues:read on that repo
```

`GITHUB_API_URL` overrides the REST base (default `https://api.github.com`).

## Part of bpm-iq

Source, content contract, and the example content repo live in
[Miragon/bpm-iq](https://github.com/Miragon/bpm-iq) — see
[docs/mcp-integration.md](https://github.com/Miragon/bpm-iq/blob/main/docs/mcp-integration.md)
for the full tool list and setup.

## License

MIT
