# Process documentation — agent guide

This repository models business processes and their strategic context, and turns them into
conversational skills. **The models are the source of truth — ground every answer in them.**
It is served by the [bpmiq](https://github.com/Miragon/bpm-iq) platform.

## Map

| Path                 | What it is                                                                                                |
| -------------------- | --------------------------------------------------------------------------------------------------------- |
| `landscape/`         | `value-chain.vc.json`, `wardley-map.owm`, `team-topology.tt`, `glossary.yaml`                             |
| `processes/<id>/`    | `process.yaml` (metadata + links), `<id>.bpmn`, `subprocesses/`, `decisions/` (DMN), `feedback/`, `docs/` |
| `processes/INDEX.md` | Portfolio overview — keep in sync when adding processes                                                   |
| `templates/process/` | Scaffold for new processes — copy, don't reinvent                                                         |
| `dist/skills/`       | Generated process-skill exports — never edit by hand, always re-export                                    |
| `.vitepress/`        | Portal: `pnpm dev`                                                                                        |
| `docs/`              | method, modeling-conventions, process-metadata, governance, migration, automation                         |

## Skills — prefer them over ad-hoc approaches

- **process-navigator** — any question about existing processes (flow, owners, rules, KPIs, impact)
- **capture-process** — interview a process owner to elicit a process from tacit knowledge
- **import-process** — turn legacy docs (Visio/Word/Confluence/images) into draft models
- **new-process** — scaffold a new process directory correctly
- **process-review** — quality gate
- **strategy-alignment** — automation/sourcing candidates, Conway mismatches, coverage gaps
- **process-performance** — compare models against event-log reality, maintain KPI actuals
- **process-feedback** — file and triage discrepancy reports (`processes/<id>/feedback/`)
- **export-process-skill** — package a process + resolved dependencies as a portable skill

## Hard rules

1. `process.yaml` references must resolve. The bpmiq platform validates on release.
2. BPMN files need a complete BPMNDI section (every flow node), or the visual editor breaks.
3. Follow `docs/modeling-conventions.md`: tasks verb+object, events object+past participle,
   gateways as questions, lanes = team labels, canonical glossary terms, rules in DMN.
4. File extensions drive the custom editors: `.bpmn`, `.dmn`, `.owm`, `.vc.json`, `.tt`.
5. Semantic model change ⇒ bump `version` + add a `history` entry; an `as-is` process needs a
   matching `approval` block (`docs/governance.md`).
6. Exports are snapshots: after changing a process with an existing `dist/skills/<id>`, re-export.
7. When the user corrects a process, don't silently edit — file it via `process-feedback` and triage.
