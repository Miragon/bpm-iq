# bpmiq — _Let your processes talk_

[![CI](https://github.com/Miragon/bpm-iq/actions/workflows/validate.yml/badge.svg)](https://github.com/Miragon/bpm-iq/actions/workflows/validate.yml)
[![GHCR](https://img.shields.io/badge/ghcr.io-miragon%2Fbpmiq--live--host-2496ed)](https://github.com/Miragon/bpm-iq/pkgs/container/bpmiq-live-host)
[![License: MIT](https://img.shields.io/badge/license-MIT-green.svg)](LICENSE)

The collaborative BPM platform where git is the system of record: model together in real
time, release as a pull request, and let AI agents query every process.

- **Model live** — every model file (`.bpmn`, `.dmn`, `.owm`, `.tt`, `.storm`, `.cm.json`,
  `.vc.json`, `.yaml`, `.md`) syncs as a shared Y.Text document; the web client and VS Code bind their editors to
  it. Login authenticates, **repos authorize**: what you see and edit follows your git write
  permission.
- **Release as PR** — one click cuts a branch from `origin/<default>`, pushes and opens
  the PR — bot-authored, with **you as the commit author**, so you can approve your own
  release. Merge = approval — governance stays at the git provider (CODEOWNERS / branch
  protection), not in the tool.
- **Processes talk** — the MCP server answers questions live from the content repo, agents
  read and edit work-in-progress models through the Live Host's own `/mcp` endpoint, the AI
  skill layer (capture, import, review, feedback, export …) travels with it, and
  `export-process-skill` packages a process with its resolved dependencies as a portable
  skill for any agent.

## Run it in 5 minutes

Evaluation mode — one container, no login (`LIVE_AUTH=none`: everyone is the local user):

```bash
docker run --rm -p 8301:8080 -e LIVE_AUTH=none \
  -e LIVE_PUBLIC_URL=http://localhost:8301 ghcr.io/miragon/bpmiq-live-host:latest
```

`LIVE_PUBLIC_URL` is the URL you actually open — deep links, the MCP resource audience and
the same-site check on browser requests derive from it, so a published port other than the
container's 8080 has to say so, or the editors never sync.

The server is up at http://localhost:8301 (`/healthz` answers): the web app, the VS Code
extension (`bpmLive.serverUrl` = `ws://localhost:8301`, no sign-in needed) and
`pnpm --filter @bpmiq/live-host test:sync` all work right away. What it serves is this
repo's example content, cloned into the container on the first request — and thrown away
again with `--rm`.

**Your own models.** A content repo is any checkout with a root `bpmiq.yml`
([`process-documentation-starter`](https://github.com/Miragon/process-documentation-starter)
is the template). Name it, and mount a volume so the clone, the live edits and their
lineages survive a restart:

```bash
docker run -p 8301:8080 -e LIVE_AUTH=none -e LIVE_PUBLIC_URL=http://localhost:8301 \
  -e GITHUB_REPO=<owner>/<repo> -v bpmiq-data:/data \
  ghcr.io/miragon/bpmiq-live-host:latest
```

That clone happens without credentials, so the repo must be public — private repos (and
release-as-PR) need the GitHub App. Already have a checkout? Bind-mount it and the host
serves it **in place**, no clone: edits write through to your working tree, `git diff`
shows them, you commit as usual. Nothing is fetched then, so `GITHUB_REPO` is a pure label —
any `<owner>/<name>`, no GitHub repository behind it:

```bash
git clone https://github.com/<owner>/<repo> my-processes   # or your own; needs a root bpmiq.yml
docker run -p 8301:8080 -e LIVE_AUTH=none -e LIVE_PUBLIC_URL=http://localhost:8301 \
  -e GITHUB_REPO=acme/my-processes -e LIVE_HOST_CONTENT_DIR=/content \
  -v "$PWD/my-processes:/content" -v bpmiq-data:/data \
  ghcr.io/miragon/bpmiq-live-host:latest
```

(A `/content` without a root `bpmiq.yml` is not a content repo: the host says so at boot and
clones `GITHUB_REPO` instead — which is where a made-up label then fails.)

A real login is your OIDC identity provider plus a GitHub App for authorization — the
15-minute path ships a Keycloak: [docs/on-prem/idp-quickstart.md](docs/on-prem/idp-quickstart.md).

From source (Node >= 23.6 — TypeScript runs directly via type stripping, no build step):

```bash
pnpm install                     # pnpm, never npm/yarn (workspace: protocol)
pnpm --filter @bpmiq/web build  # the Live Host serves apps/web/dist
LIVE_AUTH=none pnpm live-host    # sync + API + web app on http://localhost:8301, no login
#   with a login: the IdP quickstart (docs/on-prem/idp-quickstart.md) + your GitHub App
#   (one-time vendor step): GITHUB_REPO=<owner>/<repo> pnpm --filter @bpmiq/live-host create-app
```

More entry points: `pnpm web:dev` (web client with hot reload, proxies to the Live Host),
`pnpm validate` (content validation of the example repo, runs in CI on every PR).

**Talk to the processes**: open [Claude Code](https://claude.com/claude-code) in the repo —
`.mcp.json` auto-connects the read-only MCP server (`packages/mcp`) — and ask _"Walk me
through order-to-cash"_ or _"What should we automate first?"_.

To reach the **live, write-capable** endpoint of the running host instead, point a client at
`/mcp` — on a `LIVE_AUTH=none` host no credential is needed:

```bash
claude mcp add --transport http bpm-live http://localhost:8301/mcp
```

Claude Desktop's custom-connector dialog expects OAuth, so bridge a no-auth host in
`claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "bpm-live": {
      "command": "npx",
      "args": ["-y", "mcp-remote", "http://localhost:8301/mcp"]
    }
  }
}
```

Restart Desktop fully (Cmd+Q) afterwards. Against a real deployment the client fetches an
OIDC access token itself — Claude Code: `claude mcp add --transport http bpm-live
https://<host>/mcp --client-id bpmiq-mcp --callback-port 8765` with the quickstart realm —
see [docs/mcp-integration.md](docs/mcp-integration.md).

## What's in this repo

This repository is the full self-hostable platform. Miragon also operates a hosted
multi-tenant SaaS; its tenant provisioning and billing control plane is not in this repo —
but the cell mode it drives is. The code you read here is the code the SaaS runs
([ADR 0004](docs/adr/0004-open-source-split.md)).

| Path                     | Package            | What it is                                                                                                                                                                                                                                                                |
| ------------------------ | ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `apps/live-host/`        | `@bpmiq/live-host` | The platform server: Hocuspocus (Yjs) sync + REST API + web app on **one port**. Multi-repo, per-(user,repo) authz, release-as-PR. Published as `ghcr.io/miragon/bpmiq-live-host`.                                                                                        |
| `apps/web/`              | `@bpmiq/web`       | Collaborative web client: bpmn-js + Monaco on a shared Y.Text, repo overview.                                                                                                                                                                                             |
| `apps/vscode/`           | `bpm-live`         | VS Code extension: opens `bpm-live://` model documents synced through the Live Host; signs in through the host's own login (editor sign-in).                                                                                                                              |
| `packages/mcp/`          | `@bpmiq/mcp`       | Read-only MCP server exposing a content repo's processes (discovered from `bpmiq.yml`, derived from BPMN) — stdio + Streamable HTTP. Read-only, against a checkout — the live, writable MCP endpoint lives in the Live Host (`/mcp`).                                     |
| `packages/notations/`    | `@bpmiq/notations` | Notation registry + BPMN analysis: extensions/editors, `extract` (BPMN→graph), `derive` (graph→process view), and the `bpmiq.yml` content discovery.                                                                                                                      |
| `packages/validator/`    | `@bpmiq/validator` | Platform validator: `bpmiq.yml` discovery + BPMN structure and BPMNDI coverage + callActivity link integrity. Runs against any checkout via `--root`.                                                                                                                     |
| `packages/…`             | —                  | Shared foundations: `http-kit`, `github-app`, `contracts`, `live-client`, `ui-kit`, `api-client` — see `CLAUDE.md` for the full map.                                                                                                                                      |
| `process-documentation/` | —                  | Example **BPM content repo** (`bpmiq.yml` + `.bpmn` + `.claude/skills`) — the MCP/validator example AND the content-repo contract, mirrored to [`Miragon/process-documentation-starter`](https://github.com/Miragon/process-documentation-starter) ("Use this template"). |
| `deploy/`                | —                  | Docker Compose reference for self-hosting.                                                                                                                                                                                                                                |
| `docs/`                  | —                  | Platform docs: concept, multi-repo architecture, MCP integration, [ADRs](docs/adr/), [self-hosting](docs/on-prem/), [extending](docs/extending/).                                                                                                                         |

## Self-hosting

Everything the hosted SaaS runs, on your infrastructure: the GHCR image (or your own build),
the Compose reference under `deploy/`, GitHub App setup, reverse-proxy/WebSocket notes, and
persistence. Start at [docs/on-prem/](docs/on-prem/).

## Extending

The provider layer is a pair of ports — `apps/live-host/src/ports/git-provider.ts` and
`apps/live-host/src/ports/connection-source.ts` — so a GitLab connector is a new
`adapters/gitlab/` folder against existing contracts, not a fork. Session issuance has the
same seam for SSO. Boundaries are CI-enforced
([ADR 0003](docs/adr/0003-module-architecture-and-shared-packages.md)); guides live in
[docs/extending/](docs/extending/).

---

[Contributing](CONTRIBUTING.md) · [Security](SECURITY.md) · [MIT](LICENSE) © Miragon GmbH
