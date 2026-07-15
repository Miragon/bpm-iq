# bpmiq — _Let your processes talk_

[![CI](https://github.com/Miragon/bpm-iq/actions/workflows/validate.yml/badge.svg)](https://github.com/Miragon/bpm-iq/actions/workflows/validate.yml)
[![GHCR](https://img.shields.io/badge/ghcr.io-miragon%2Fbpmiq--live--host-2496ed)](https://github.com/Miragon/bpm-iq/pkgs/container/bpmiq-live-host)
[![License: MIT](https://img.shields.io/badge/license-MIT-green.svg)](LICENSE)

The collaborative BPM platform where git is the system of record: model together in real
time, release as a pull request, and let AI agents query every process.

- **Model live** — every model file (`.bpmn`, `.dmn`, `.owm`, `.tt`, `.vc.json`, `.yaml`,
  `.md`) syncs as a shared Y.Text document; the web client and VS Code bind their editors to
  it. Login authenticates, **repos authorize**: what you see and edit follows your git write
  permission.
- **Release as PR** — one click validates the process, cuts a branch from
  `origin/<default>`, pushes **as the user**, and opens the PR in their name. Merge =
  approval — governance stays at the git provider (CODEOWNERS / branch protection), not in
  the tool.
- **Processes talk** — the MCP server answers questions live from the content repo, the AI
  skill layer (capture, import, review, feedback, export …) travels with it, and
  `export-process-skill` packages a process with its resolved dependencies as a portable
  skill for any agent.

## Run it in 5 minutes

Evaluation mode — one container, no git provider, a dev token:

```bash
docker run --rm -p 8301:8080 -e LIVE_DEV_TOKEN=demo ghcr.io/miragon/bpmiq-live-host:latest
```

The server is up at http://localhost:8301 (`/healthz` answers). The browser login needs a
GitHub app (the 10-minute path: [docs/on-prem/](docs/on-prem/)); the dev token `demo` drives
the headless clients right away — the VS Code extension (`bpmLive.serverUrl` =
`ws://localhost:8301`, `bpmLive.token` = `demo`) and `pnpm --filter @bpmiq/live-host
test:sync`. `LIVE_DEV_TOKEN` is dev-only: it switches itself off as soon as a login provider
is configured.

From source (Node >= 23.6 — TypeScript runs directly via type stripping, no build step):

```bash
pnpm install                     # pnpm, never npm/yarn (workspace: protocol)
pnpm --filter @bpmiq/web build  # the Live Host serves apps/web/dist
pnpm live-host                   # sync + API + web app on http://localhost:8301
#   GitHub login (one-time vendor step): GITHUB_REPO=<owner>/<repo> pnpm --filter @bpmiq/live-host create-app
```

More entry points: `pnpm portal:dev` (VitePress portal, renders all models live),
`pnpm web:dev` (web client with hot reload, proxies to the Live Host), `pnpm validate`
(content validation, runs in CI on every PR).

**Talk to the processes**: open [Claude Code](https://claude.com/claude-code) in the repo —
`.mcp.json` auto-connects the MCP server (`packages/mcp`) — and ask _"Walk me through
order-to-cash"_ or _"What should we automate first?"_.

## What's in this repo

This repository is the full self-hostable platform. Miragon also operates a hosted
multi-tenant SaaS; its tenant provisioning and billing control plane is not in this repo —
but the cell mode it drives is. The code you read here is the code the SaaS runs
([ADR 0004](docs/adr/0004-open-source-split.md)).

| Path                     | Package                 | What it is                                                                                                                                                                                                                         |
| ------------------------ | ----------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `apps/live-host/`        | `@bpmiq/live-host`      | The platform server: Hocuspocus (Yjs) sync + REST API + web app on **one port**. Multi-repo, per-(user,repo) authz, release-as-PR. Published as `ghcr.io/miragon/bpmiq-live-host`.                                                 |
| `apps/web/`              | `@bpmiq/web`            | Collaborative web client: bpmn-js + Monaco on a shared Y.Text, repo overview.                                                                                                                                                      |
| `apps/vscode/`           | `@bpmiq/vscode`         | VS Code extension: opens `bpm-live://` model documents synced through the Live Host.                                                                                                                                               |
| `packages/mcp/`          | `@bpmiq/mcp`            | Read-only MCP server exposing a content repo's process graph (stdio + Streamable HTTP).                                                                                                                                            |
| `packages/notations/`    | `@bpmiq/notations`      | Notation registry: one descriptor per modeling notation — live-host, validator and web derive extensions/editors from it.                                                                                                          |
| `packages/validator/`    | `@bpmiq/validator`      | Platform validator: schema, link integrity, BPMN/DMN structure, governance, export freshness. Runs against any checkout via `--root`; holds the canonical `schemas/`.                                                              |
| `packages/…`             | —                       | Shared foundations: `http-kit`, `github-app`, `contracts`, `live-client`, `ui-kit`, `api-client` — see `CLAUDE.md` for the full map.                                                                                               |
| `process-documentation/` | `process-documentation` | Example **BPM content repo** + VitePress portal — the content contract the platform serves. Mirrored to [`Miragon/process-documentation-starter`](https://github.com/Miragon/process-documentation-starter) ("Use this template"). |
| `deploy/`                | —                       | Docker Compose reference for self-hosting.                                                                                                                                                                                         |
| `docs/`                  | —                       | Platform docs: concept, multi-repo architecture, MCP integration, [ADRs](docs/adr/), [self-hosting](docs/on-prem/), [extending](docs/extending/).                                                                                  |

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
