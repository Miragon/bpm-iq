---
name: new-process
description: Scaffolds a new business process in this repository — creates a single BPMN file under the processes folder with a complete diagram (semantics + layout), lanes for the owning roles, and callActivity links to any sub-processes. Use when the process facts (trigger, outcome, roles, rough flow) are already known — from the user or a capture-process interview — and the user wants to add, scaffold, or start modeling a new process.
---

# New Process

Scaffold a process as a single `.bpmn` file. The slim content contract is just
`bpmiq.yml` + `.bpmn` files: a process IS its BPMN, there is no `process.yaml`,
no landscape, no INDEX. The process id is the file name without the extension.

## Inputs to gather

From the user's request (ask only for what you cannot infer):

- **id** — kebab-case, unique across the repo (the `.bpmn` file stem), e.g. `order-to-cash`.
- **name** — human title; model it as the pool name so it is derivable.
- **trigger** — the start event (object + past participle, e.g. "Order received").
- **outcome(s)** — the end event(s).
- **happy path** — the ordered steps between trigger and outcome.
- **roles** — who does what → BPMN **lanes** (lane name = team/role label).
- **decisions** — branch points → gateways phrased as questions.
- **sub-processes** — steps complex enough to be their own `.bpmn`; link via a
  `callActivity` whose `calledElement` is the sub-process's id (its file stem).

## Steps

1. Find the processes folder from `bpmiq.yml` (`processes:` key). Confirm the id
   is free: no existing `<folder>/**/<id>.bpmn`.
2. Write `<folder>/<id>.bpmn` — one `<bpmn:process>` (or a collaboration with one
   pool named after the process). Include:
   - a **laneSet** with one lane per role, every flow node assigned to a lane;
   - the flow: start event → tasks/gateways → end event(s), all `sequenceFlow`s
     wired (`sourceRef`/`targetRef`);
   - a **complete `bpmndi:BPMNPlane`**: a `BPMNShape` for every flow node, lane
     and pool, and a `BPMNEdge` for every sequence/message flow. Missing DI breaks
     the visual editor (Hard Rule).
3. For each sub-process, create a separate `<folder>/subprocesses/<sub-id>.bpmn`
   the same way, and reference it from the parent via
   `<callActivity calledElement="<sub-id>">`.
4. Follow the modeling conventions: tasks **verb + object** ("Check credit limit"),
   events **object + past participle**, gateways as **questions** ("Approved?").
5. Validate before finishing:
   `node packages/validator/src/validate.ts --root .` (from the monorepo root) —
   fix every error. The validator checks XML well-formedness, flow structure,
   BPMNDI coverage, and that each `callActivity` resolves to a real process.

## Output

Report the new file path(s) and the derived view the platform will show
(`get_process` via the MCP server, or `deriveProcess`): name, roles, steps,
gateways, and sub-process calls. Do not invent metadata that is not in the model.
