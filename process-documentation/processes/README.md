# Processes — Levels 2–4

One directory per end-to-end process. The directory name **is** the process id (kebab-case).

```
processes/
├── INDEX.md                      # portfolio overview — one row per process
└── <process-id>/
    ├── process.yaml              # metadata + dependency links (required)
    ├── <process-id>.bpmn         # level-2 end-to-end model (required)
    ├── subprocesses/             # level-3 decompositions (optional)
    │   └── <subprocess-id>.bpmn
    ├── decisions/                # DMN decision tables behind gateways (optional)
    │   └── <decision-id>.dmn
    ├── feedback/                 # discrepancy reports: reality correcting the model (optional)
    │   └── YYYY-MM-DD-<slug>.md
    └── docs/                     # level-4 narrative docs & work instructions (optional)
        ├── overview.md
        └── tasks/<element-id>.md # per-task work instruction, keyed by BPMN element id
```

Every process declares a `classification` (`core` | `support` | `management`) — core processes
anchor in value chain steps, support/management processes in `supports[]`.

- `process.yaml` is the contract — schema in [docs/process-metadata.md](../docs/process-metadata.md)
  and [schemas/process.schema.json](../schemas/process.schema.json). Every reference must
  resolve — `scripts/validate.ts` (and CI) enforces it.
- Modeling rules: [docs/modeling-conventions.md](../docs/modeling-conventions.md).
- Capture a process from a process owner's head with `capture-process`; import legacy
  documentation with `import-process`; scaffold greenfield with `new-process`.
- Ask anything about these processes with the `process-navigator` skill; check performance
  against event data with `process-performance`.
- Review with `process-review`; triage corrections with `process-feedback`.
- Package a process for other agents with the `export-process-skill` skill.

The example process [`order-to-cash/`](order-to-cash/) shows all conventions in action —
including a call activity into a level-3 sub-process and lanes that map to teams in the
team topology.
