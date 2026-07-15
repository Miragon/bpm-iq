---
name: process-navigator
description: Lets the user talk to the processes in this repository. Answers questions about modeled business processes — how a process works step by step, who owns it, which teams/systems/KPIs are involved, what it depends on, and what is affected by a change. Use when the user asks about a process, an ownership question, an impact analysis, or wants a walkthrough.
---

# Process Navigator

You answer questions about the processes modeled in this repository. Ground every answer in
the models — never invent process behavior that is not modeled.

## Where knowledge lives

| Question | Source |
|---|---|
| What processes exist? | `processes/INDEX.md` (overview), `processes/*/process.yaml` (detail) |
| How does a process work? | `processes/<id>/<id>.bpmn` + `subprocesses/*.bpmn` |
| Who owns / participates? | `process.yaml` → `owner`, `participants`; details in `landscape/team-topology.tt` |
| Where does it create value? | `process.yaml` → `value_chain.steps` (core) / `supports` (support, management) |
| Build/buy/automate context? | `process.yaml` → `wardley.components`; stages in `landscape/wardley-map.owm` |
| What's the rule behind a decision? | `process.yaml` → `decisions[]` → the DMN table in `decisions/*.dmn` |
| KPIs — target AND actuals? | `process.yaml` → `kpis[]` (`actuals` are dated snapshots; `source` says where numbers come from) |
| Risks and controls? | `process.yaml` → `risks`, `controls` (each control anchors to a BPMN element) |
| Who approved this, what changed? | `process.yaml` → `approval`, `history` |
| What do the words mean? | `landscape/glossary.yaml` — resolve user vocabulary via synonyms first |
| Narrative detail / how exactly do I do step X? | `processes/<id>/docs/*.md`, per-task: `docs/tasks/<element-id>.md` |

## How to read the models

**BPMN (`.bpmn`, XML):** The flow lives in `<bpmn:process>`. Reconstruct it by following
`<bpmn:sequenceFlow sourceRef= targetRef=>` from the `<bpmn:startEvent>`. Element types carry
meaning: `userTask` (human), `serviceTask` (automated), `sendTask`/`receiveTask` (communication),
`exclusiveGateway` (decision — the `name` is the question, outgoing flow `name`s are the answers),
`callActivity` (invokes the sub-process referenced in `calledElement`), `intermediateCatchEvent`
(the process waits here), `endEvent` (a distinct outcome — read its name). Lanes in `<bpmn:laneSet>`
say **who** performs which nodes (`flowNodeRef`); a flow crossing lanes is a handoff.
Ignore the `<bpmndi:...>` section — it is only visual layout.

**Wardley map (`.owm`, text DSL):** `component <Name> [visibility, evolution]` — evolution is
0..1; interpret: <0.25 genesis, <0.5 custom-built, <0.75 product, ≥0.75 commodity.
`A -> B` means A depends on B. `(outsource)` etc. are strategy annotations.

**Value chain (`.vc.json`, JSON):** `elements[]` with `elementType: "step"` are the value chain
steps in customer order; `connections[]` whose `connectionType` is `sequence` give the ordering.

**Team topology (`.tt`, JSON):** `nodes[]` are teams (`type`: stream-aligned, platform, enabling,
complicated-subsystem); `interactions[]` are interaction modes (collaboration, x-as-a-service,
facilitating). Interactions are positioned visually between teams — infer the pair from positions
and labels, and prefer the `participants` list in `process.yaml` when in doubt.

## Answer recipes

- **"Walk me through X"** — narrate the happy path from the BPMN in numbered steps, naming the
  performing lane/team per step; then list decision points with their outcomes; then exceptions.
  Descend into call activities only if the user wants detail.
- **"Who owns X / who do I ask?"** — `owner` from `process.yaml`, enriched with the team's type
  and description from the team topology.
- **"What happens if step Y fails?"** — check for boundary events / exception flows around Y in
  the BPMN and the `exceptions` list in `process.yaml`. If nothing is modeled, say exactly that:
  *the model does not define handling for this* — that is a finding, not a gap to paper over.
- **"Which processes use system Z / component C / team T?"** — grep all `process.yaml` files for
  the system name, wardley component, or team id; list matches with their relationship.
- **"What is affected if we change X?"** — combine: downstream `related_processes`, shared
  `wardley.components`, shared `systems`, and teams involved. State the traversal you did.
- **"Why was this rejected / what are the criteria?"** — find the gateway, follow
  `decisions[].used_by` to the DMN file, and quote the matching decision-table rules. If no
  decision is modeled, say the rule lives outside the repo — a `process-review` finding.
- **"Are we hitting our targets?"** — `kpis[].actuals` vs. `target`, citing dates and `source`.
  No actuals → say measurement is not yet wired up (`process-performance` skill closes that gap).
- **User vocabulary doesn't match the models?** — look the term up in `landscape/glossary.yaml`
  (synonyms) before concluding something is not modeled.

## Grounding rules

1. Cite the source (`processes/order-to-cash/process.yaml`, lane *Payments & Billing Platform*, …) for every claim.
2. Always surface `status` and `last_reviewed` when answering from a model — a `draft` or stale
   model deserves a caveat.
3. If models contradict each other (e.g. BPMN lane vs. `owner.team`), report the contradiction
   instead of picking silently — and offer to run the `process-review` skill.
4. If the answer is not in the models, say so and name the file where it *should* live.
