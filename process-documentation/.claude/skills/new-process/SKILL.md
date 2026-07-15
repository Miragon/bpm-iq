---
name: new-process
description: Scaffolds a new business process in this repository — creates the directory from the template, fills in process.yaml metadata, wires it into the landscape models (value chain, Wardley map, team topology), and prepares the initial BPMN skeleton. Use when the process facts (trigger, outcome, owner, rough flow) are already known — from the user or a capture-process interview — and the user wants to add, scaffold, or start modeling a new process.
---

# New Process

Scaffold a process directory that follows the repository conventions from day one.

## Inputs to gather

From the user's request (ask only for what you cannot infer):

1. **id** — kebab-case, becomes the directory name (e.g. `customer-onboarding`)
2. **name, purpose, trigger, outcome** — one sentence each
3. **classification** — `core` (creates customer value → needs value chain steps), `support`
   (enables others → needs `supports[]`), or `management`
4. **owner team** — must exist in `landscape/team-topology.tt`; list available teams if unclear
5. **value chain step(s)** (core) or **supports** targets (support) — must resolve
6. **wardley components** the process depends on — match against `landscape/wardley-map.owm`
7. Optional: KPIs (with `source`), systems, participants, related processes

If the user only has tacit knowledge and no clear flow yet, hand over to the
`capture-process` skill first — it interviews, this skill scaffolds.

## Steps

1. **Check for collisions**: the id must not already exist under `processes/`.
2. **Copy the template**: `templates/process/` → `processes/<id>/`.
3. **Rename** `process.bpmn` → `<id>.bpmn`; inside it, set the process `id="<id>"` and `name`
   to the process name — then update the DI to match: `<bpmndi:BPMNPlane bpmnElement=...>` must
   reference the new process id (also rename the `Definitions_`/`BPMNDiagram_`/`BPMNPlane_` ids
   for consistency). A DI plane pointing at the old id renders an empty canvas.
4. **Fill `process.yaml`**: replace every `<placeholder>`. Set `status: draft`,
   `version: 0.1.0`, `last_reviewed:` today — for a draft this is the scaffold date, not a
   confirmed review (see `docs/process-metadata.md`); say so in your report. Follow
   `docs/process-metadata.md` for all fields.
5. **Validate landscape links** (do not skip):
   - `owner.team` and every `participants[].team` exist as node ids in `landscape/team-topology.tt`
   - every `value_chain.steps[]` exists as an element id in `landscape/value-chain.vc.json`
   - every `wardley.components[]` matches a `component <Name>` line in `landscape/wardley-map.owm` exactly
   - If a reference is missing, ask whether to (a) add the element to the landscape model or
     (b) pick an existing one. Extending the landscape is a strategic act — confirm before editing.
6. **Sketch the first BPMN draft** if the user described the flow: rename/extend the skeleton
   elements following `docs/modeling-conventions.md` (tasks = verb + object, events = object +
   past participle, gateways = closed questions with labeled yes/no flows). Keep DI coordinates
   consistent — copy the layout patterns from `templates/process/process.bpmn` or any existing
   process (e.g. `processes/order-to-cash/order-to-cash.bpmn` if still present).
7. **Fill `docs/overview.md`** with what is known; leave explicit `<todo>` markers for gaps.
8. **Register**: add a row to `processes/INDEX.md`; write the initial `history` entry
   (version 0.1.0, "Initial scaffold"); propose `landscape/glossary.yaml` entries for domain
   terms the process introduces (ask before adding).
9. **Validate & report**: run `node scripts/validate.ts <id>`; report created files,
   resolved links, validator output, and open todos. Suggest opening the `.bpmn` in the
   BPMN Modeler for visual refinement, and `process-review` once the model has substance.

## Rules

- Never leave a `<placeholder>` in a committed `process.yaml` — either fill it or remove the
  optional block.
- One directory = one level-2 process. Sub-steps that deserve their own diagram go to
  `subprocesses/` and are referenced via a `callActivity` with `calledElement="<subprocess-id>"`.
- New BPMN files must contain a BPMNDI diagram section, otherwise the visual editor shows an
  empty canvas.
