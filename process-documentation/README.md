# process-documentation — example BPM content repo

The example **BPM content repository** the bpmiq platform serves — the content
counterpart to the platform code in this monorepo, and the working example the
MCP server and validator run against.

## The contract

A content repo is a root **`bpmiq.yml`** naming the folder its BPMN processes
live in:

```yaml
processes: processes
```

- Every `.bpmn` file under that folder (subfolders included) is a **process**.
- A process's **id** is its file name without the extension
  (`processes/order-to-cash.bpmn` → `order-to-cash`).
- There is no hand-written metadata: the process view (name, roles from lanes,
  steps, flow, sub-process calls) is **derived from the BPMN on the fly**
  (`@bpmiq/notations/derive`).

```
bpmiq.yml
processes/
  order-to-cash.bpmn
  subprocesses/
    invoice-handling.bpmn   ← called by order-to-cash (callActivity calledElement)
```

## Working with it

- **Model live**: open the repo in the bpmiq web app; every `.bpmn` is a process
  you can co-edit. Release → PR publishes a process's live state.
- **Ask the processes**: the MCP server (`packages/mcp`) answers questions over
  this content (`list_processes`, `get_process`, `who_owns`, `enumerate_paths`, …).
- **Validate**: `node packages/validator/src/validate.ts --root .` (from the repo
  root) checks BPMN structure + BPMNDI coverage.
- **Skills**: `.claude/skills/` carries the AI toolset that operates on this repo.

The minimal seed of this contract lives in the monorepo's `starter/` and is
mirrored to [`Miragon/process-documentation-starter`](https://github.com/Miragon/process-documentation-starter).
