# Process documentation — agent guide

This repository models business processes as BPMN. **The models are the source
of truth — ground every answer in them.** It is served by the
[bpmiq](https://github.com/Miragon/bpm-iq) platform.

## The contract (slim)

- A root **`bpmiq.yml`** names the models folder (`processes: processes`).
- Every file with a notation extension under it is a **model** — `.bpmn` a
  process, `.dmn` a decision; its id is the file name without the extension.
  There is NO `process.yaml` — the process view (name, roles from lanes, steps,
  flow, sub-process calls) is derived from the BPMN.
- Sub-processes are separate `.bpmn` files, called via `callActivity`
  `calledElement="<process-id>"`; decisions are `.dmn` files called from a
  `businessRuleTask` via `calledDecision="<decision-id>"`, with their cases in
  `<decision>.tests.yaml` next to them.

```
bpmiq.yml
processes/
  order-to-cash.bpmn              the process
  order-to-cash.storm             same id, other notation — one model, two views
  credit-limit-check.dmn          called by order-to-cash
  credit-limit-check.tests.yaml   its cases (pnpm validate runs them)
  subprocesses/invoice-handling.bpmn
```

File names are ids: kebab-case, English, descriptive — and `calledElement` /
`calledDecision` point at them, so a rename is a rename of every reference too.
Never leave scratch models (`test1.bpmn`, `des.dmn`) in the folder.

## Skills — prefer them over ad-hoc approaches

- **process-navigator** — any question about existing processes (flow, roles, impact)
- **capture-process** — interview a process owner to elicit a process from tacit knowledge
- **import-process** — turn legacy docs (Visio/Word/Confluence/images) into a draft `.bpmn`
- **new-process** — scaffold a new process `.bpmn`
- **process-review** — quality gate (runs the validator, then judgment checks)
- **process-feedback** — file and triage discrepancy reports
- **export-process-skill** — package a process as a portable skill

## Hard rules

1. BPMN files need a complete BPMNDI section (every flow node), or the visual
   editor breaks. Keep semantics (`bpmn:*`) and layout (`bpmndi:*`) in sync.
2. After ANY model edit, validate: `node packages/validator/src/cli.ts --root .`
   (from the monorepo root) — fix errors before finishing.
3. Modeling conventions: tasks verb+object, events object+past participle,
   gateways as questions, lanes = team/role labels.
4. A `callActivity`'s `calledElement` should match another process's id (its
   `.bpmn` file stem) — the validator warns on a dangling call.
5. When the user corrects a process, don't silently edit — file it via
   `process-feedback` and triage.
