# @bpmiq/mcp

Read-only MCP server that exposes a BPM content repo's process graph — processes, owners,
KPIs, dependency paths, cycles, glossary, landscape models — to any MCP client (Claude Code,
Claude Desktop, IDEs, ...). Read-only by construction: the tools only ever read files, and all
of them carry `readOnlyHint`.

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

## Part of bpm-iq

Source, content contract, and the example content repo live in
[Miragon/bpm-iq](https://github.com/Miragon/bpm-iq) — see
[docs/mcp-integration.md](https://github.com/Miragon/bpm-iq/blob/main/docs/mcp-integration.md)
for the full tool list and setup.

## License

MIT
