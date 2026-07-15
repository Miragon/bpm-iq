# The Method: Four Views, One Model

Pure process management has a value problem: a repository full of BPMN diagrams that nobody
reads is documentation, not management. Value emerges when a process is connected to the
questions that actually matter — and when you can _ask_ those questions in plain language.

This starter connects four complementary views. Each answers one question no other view can:

| View                | Question                                                | Model                                     | Location     |
| ------------------- | ------------------------------------------------------- | ----------------------------------------- | ------------ |
| **Value Chain**     | _Where_ does this process create value?                 | Value chain model                         | `landscape/` |
| **Wardley Map**     | _Why_ build, buy, or automate the capabilities it uses? | Wardley map                               | `landscape/` |
| **Team Topologies** | _Who_ owns it, and how do teams interact around it?     | Team topology model                       | `landscape/` |
| **BPMN**            | _How_ does the work actually flow?                      | BPMN 2.0 diagrams (+ DMN decision tables) | `processes/` |

Two artifacts hold the views together: the **glossary** (`landscape/glossary.yaml`) pins the
vocabulary all models speak, and each process's **classification** (`core` — anchored in value
chain steps; `support` / `management` — anchored via `supports[]`) gives every process a
legitimate place in the landscape, not just the customer-facing ones.

## The glue: `process.yaml`

Every process directory contains a `process.yaml` (see [process-metadata.md](process-metadata.md)).
It is the **dependency graph** of the repository: it links the BPMN flow to its value chain step,
its Wardley components, its owning team, its systems, KPIs, and related processes.

```
                       landscape/
        ┌────────────────┬────────────────┬──────────────────┐
        │  value chain   │  wardley map   │  team topology   │
        └───────▲────────┴───────▲────────┴────────▲─────────┘
                │value_chain.steps│ wardley.components│ owner.team
                │                │                 │
            ┌───┴────────────────┴─────────────────┴───┐
            │        processes/<id>/process.yaml        │
            └───┬───────────────┬───────────────────┬───┘
                │ models.bpmn   │ subprocesses      │ docs
                ▼               ▼                   ▼
            <id>.bpmn      subprocesses/*.bpmn   docs/*.md
```

Because these links are explicit and machine-readable, an AI agent can traverse them —
that is what makes processes _conversational_, and what makes a process **exportable as a
self-contained skill** (see the `export-process-skill` skill).

## Process architecture levels

The repository follows the classic BPM architecture pyramid:

- **Level 1 — Landscape** (`landscape/`): the value chain is the process map. Every step of
  the value chain is realized by one or more end-to-end processes.
- **Level 2 — End-to-end processes** (`processes/<id>/<id>.bpmn`): trigger-to-outcome flows
  that deliver value to a customer or internal stakeholder (e.g. _Order to Cash_).
  One directory per process.
- **Level 3 — Sub-processes** (`processes/<id>/subprocesses/`): decompositions of level-2
  activities, referenced from the parent via call activities or sub-process markers.
- **Level 4 — Work instructions** (`processes/<id>/docs/`): narrative documentation, checklists,
  and work instructions in Markdown.

## How the views inform decisions

- **Automation candidates**: a process step that leans on a _commodity_ Wardley component but is
  performed manually is an automation candidate. A _genesis_ component wrapped in a rigid process
  is being standardized too early.
- **Ownership friction**: a level-2 process crossing many stream-aligned teams accumulates handoff
  cost — the team topology shows where the flow fights the org (Conway's law).
- **Coverage gaps**: a value chain step without any linked process is either undocumented or
  not managed; a process without a value chain link has no articulated reason to exist.

The `strategy-alignment` skill runs exactly these analyses on demand.

## Lifecycle

Processes move through `status` values in `process.yaml`:

`draft` → `to-be` → `as-is` → `deprecated`

Model the _to-be_ next to the _as-is_ when redesigning: keep both BPMN files in the same
process directory (e.g. `<id>.bpmn` and `<id>.to-be.bpmn`) and record the redesign decision in
`docs/`; `status` flips to `as-is` when the to-be model replaces the old one. Never let a
diagram silently diverge from reality —
the review skill (`process-review`) checks metadata freshness alongside model quality.
