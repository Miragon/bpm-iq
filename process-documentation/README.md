# process-documentation-starter

A starter for **BPM process documentation** that the [bpmiq](https://github.com/Miragon/bpm-architect)
platform serves: model your processes and their strategic context, then let them talk.

> This repository is **auto-synced** from `process-documentation/` in the bpmiq monorepo.
> Use it as a GitHub template ("Use this template") to create your own content repository,
> then connect it in bpmiq — the platform clones it, renders the portal, and answers
> questions about it over MCP.

## Layout

| Path                 | What it is                                                                                                             |
| -------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| `processes/<id>/`    | One process: `process.yaml` (metadata + links), `<id>.bpmn`, `subprocesses/`, `decisions/` (DMN), `feedback/`, `docs/` |
| `processes/INDEX.md` | Portfolio overview                                                                                                     |
| `landscape/`         | `value-chain.vc.json`, `wardley-map.owm`, `team-topology.tt`, `glossary.yaml`                                          |
| `templates/process/` | Scaffold for new processes — copy, don't reinvent                                                                      |
| `docs/`              | method, modeling-conventions, process-metadata, governance, migration, automation                                      |
| `.vitepress/`        | Portal: `pnpm dev` renders all models via bpmn-js/dmn-js/Miragon renderers                                             |
| `.claude/skills/`    | AI-first toolset — ask your processes questions (see `CLAUDE.md`)                                                      |
| `dist/skills/`       | Exported portable process skills                                                                                       |

## Use it

```bash
pnpm install
pnpm dev        # the portal at http://localhost:5173
```

Validation, live co-modeling, and PR-based release come from the **bpmiq** platform once
this repo is connected there.
