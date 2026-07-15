# Landscape — Level 1

The strategic context every process links into. Four artifacts, four questions:

| File | View | Question it answers | Editor |
|---|---|---|---|
| `value-chain.vc.json` | Value chain | Where is value created? | Value Chain Modeler (`*.vc.json`) |
| `wardley-map.owm` | Wardley map | How evolved are our capabilities — build, buy, or automate? | Wardley Mapping Modeler (`*.owm`) |
| `team-topology.tt` | Team topologies | Who owns what, and how do teams interact? | Team Topologies Modeler (`*.tt`) |
| `glossary.yaml` | Ubiquitous language | What do our words mean (and which synonyms map to them)? | any text editor |

## Identifiers — the contract with `process.yaml`

Processes reference these models by id/name. **Renaming here breaks links there** — run the
`process-review` skill after any landscape change.

- **Value chain steps** are referenced by element `id` (e.g. `step-fulfillment`).
- **Wardley components** are referenced by their exact display name (e.g. `Payment Processing`) —
  the OWM text format has no separate ids.
- **Teams** are referenced by node `id` (e.g. `team-order-management`).
- **Glossary terms** are the canonical vocabulary for BPMN element names and docs; synonyms
  map user language onto them.

`scripts/validate.ts` (and CI) verifies every reference after each change.

## Editing

Open any file in VS Code — the Miragon custom editors activate automatically on the file
extensions above. All four formats are plain text (JSON / OWM DSL / YAML) and diff cleanly in
git; you can also edit them textually or let an AI agent do it.

Conventions for these models live in [docs/modeling-conventions.md](../docs/modeling-conventions.md).
