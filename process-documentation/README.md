# process-documentation — example BPM content repo

The example **BPM content repository** the bpmiq platform serves — the content
counterpart to the platform code in this monorepo, and the working example the
MCP server and validator run against.

## The contract

A content repo is a root **`bpmiq.yml`** naming the folder its models live in:

```yaml
processes: processes
```

- Every file with a known notation extension under that folder (subfolders
  included) is a **model** — `.bpmn` a process, `.dmn` a decision.
- A model's **id** is its file name without the extension
  (`processes/order-to-cash.bpmn` → `order-to-cash`).
- There is no hand-written metadata: the process view (name, roles from lanes,
  steps, flow, sub-process calls) is **derived from the BPMN on the fly**
  (`@bpmiq/notations/derive`).

```
bpmiq.yml
processes/
  order-to-cash.bpmn              ← the process
  order-to-cash.storm             ← same id, other notation: the event-storming session behind it
  credit-limit-check.dmn          ← called by order-to-cash (businessRuleTask calledDecision)
  credit-limit-check.tests.yaml   ← its test cases, run by `pnpm validate`
  subprocesses/
    invoice-handling.bpmn         ← called by order-to-cash (callActivity calledElement)
```

## File naming

The file name is not decoration — it IS the model id, and the id is what other
models link to. So:

- **kebab-case, English, descriptive**: `credit-limit-check.dmn`, not
  `Kreditpruefung v2 final.dmn`.
- **The stem is the link target**: `calledElement="invoice-handling"` and
  `calledDecision="credit-limit-check"` are file stems. Renaming a file renames
  the id — fix every reference in the same commit (`pnpm validate` catches the
  dangling ones).
- **Same stem, other extension = the same model in another notation**
  (`order-to-cash.bpmn` + `order-to-cash.storm` are one model, two views).
- **Test cases sit next to their decision** as `<decision>.tests.yaml`.
- No scratch files in the models folder — `test1.bpmn`, `copy of ….dmn` and
  friends become processes the whole organization sees.

## Working with it

- **Model live**: open the repo in the bpmiq web app; every `.bpmn` is a process
  you can co-edit. Release → PR publishes a process's live state.
- **Ask the processes**: the MCP server (`packages/mcp`) answers questions over
  this content (`list_processes`, `get_process`, `who_owns`, `enumerate_paths`, …).
- **Validate**: `node packages/validator/src/cli.ts --root .` (from the repo
  root) checks BPMN structure + BPMNDI coverage.
- **Skills**: `.claude/skills/` carries the AI toolset that operates on this repo.

This repo is mirrored to [`Miragon/process-documentation-starter`](https://github.com/Miragon/process-documentation-starter)
as the "Use this template" starter.
