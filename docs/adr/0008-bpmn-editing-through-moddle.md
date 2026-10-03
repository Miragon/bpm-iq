# ADR 0008 — BPMN is edited through bpmn-moddle: a platform-free design core, optional implement adapters

- **Status:** proposed (2026-09-30)
- **Implementation:** `packages/bpmn-edit` (`@bpmiq/bpmn-edit`), the opt-in `/mcp` tools in `apps/live-host`
- **Related:** [0003](0003-module-architecture-and-shared-packages.md) (hexagonal backends, `pnpm arch`),
  [0005](0005-in-process-mcp-and-oidc-resource-server.md) (the `/mcp` write surface this extends),
  [0006](0006-notation-plugins-and-structured-doc-shape.md) (notation capability slots)

## Context

An agent changes a process by rewriting the **whole XML, BPMNDI coordinates included** (`get_bpmn_xml` →
`save_bpmn_xml`; `new-process` asks for a hand-written `BPMNPlane`). Cost and error rate grow with model size, the
layout is guessed, and every save replaces a document co-editors may be working in. Reading has one home
(`@bpmiq/notations/extract`, `fast-xml-parser`, rule `one-bpmn-reader`); writing has none.

Findings that shape the decision:

1. **Plain `bpmn-moddle` roundtrips any platform.** Without a platform descriptor it re-serializes C7 and C8 files
   byte for byte (modeler style) and keeps every foreign extension (`camunda:`, `zeebe:`, `bpmiq:`, vendor
   namespaces). Descriptors are only needed for **typed** access to implementation details — and a loaded descriptor
   drops a declared but unused namespace on write.
2. **Writing platform extensions is the real risk.** A first prototype wrote `<zeebe:userTask/>` into a C7 file, gave
   new tasks no lane (no role in the derived view) and a flow id style foreign to the file.
3. **bpmiq's decision link is off-schema.** Design models link decisions with an unprefixed `calledDecision`
   (hard rule 5). BPMN has no task→decision link; engines use `camunda:decisionRef` (C7) or
   `<zeebe:calledDecision decisionId>` (C8). Readers accept every spelling; an editor must pick one to write.
4. **Readability is a layout requirement.** Diagrams read like a book — left to right, else top to bottom. An editor
   that drops a new node into the nearest free space keeps diffs small but breaks that order; the modeler's space
   tool (move everything after the insertion one column on) keeps it.

## Decision

1. **BPMN is written through `bpmn-moddle`** in the isomorphic package `@bpmiq/bpmn-edit` (only `src/main.ts`, the
   CLI, is Node-bound; `pnpm arch` rule `bpmn-edit-stays-isomorphic`). Reading and deriving stay in
   `notations/extract`. The package offers an outline (semantics without DI, optionally the neighbourhood of one
   element), atomic edit operations with computed geometry, three layout modes (`tidy`, `relayout`, `layout`) and
   layout metrics.

2. **Design core and implement adapters.**
   - **Design core (every file):** `insertAfter` (into a flow, or as a new `branch`), `insertBetween`, `remove`,
     `connect`, `rename`, `changeType` (within task kinds / gateway kinds), `setCondition`, `setDefault`, `addLane`,
     `moveToLane`, `setCalledElement`, `setCalledDecision`, `addErrorBoundary` (to a node or a new end event).
   - **Implement adapters:** C8 (`zeebe-bpmn-moddle`) writes `ioMapping`, `taskHeaders`, `calledDecision`,
     `calledElement`, the native `userTask` and element templates; C7 (`camunda-bpmn-moddle`) writes `inputOutput`,
     `decisionRef` and element templates. Adapters also contribute implementation details to the outline (job type,
     class/expression/topic, script, form, assignment, mappings, headers).

3. **The platform is detected, never imposed.** `modeler:executionPlatform` decides ("Camunda Platform" → C7,
   "Camunda Cloud" → C8), else the engine namespace the file actually uses; none or both means design. Forks with
   an own namespace (Operaton is unverified) stay design until an adapter exists. An implementation detail on a
   design file is an error naming the platform; there is no conversion between platforms.

4. **An edit follows the file and changes nothing but the edit.**
   - No platform extension from the core, no foreign extension dropped; root namespace declarations survive a write.
   - Links use the spelling the file already uses, else the platform's (unprefixed `calledDecision` in design
     models). Existing content is not migrated.
   - New nodes join their anchor's lane; flow and DI ids follow the file's style (modeler hash, numbered,
     `flow_xToY`, descriptive); `<bpmn:incoming>/<bpmn:outgoing>` lists are kept only where the file keeps them.
   - No bpmiq descriptor is loaded: stickies pass through untyped and follow the flow node nearest to them when a
     layout moves it.

5. **Geometry keeps the reading order, locally.** An insertion into a flow makes room like the space tool: the rest
   of the sequence moves one column on, and the new node takes the row that flow leads into (at the target's place
   when the target stood below the anchor). A branch goes into the next column, below the anchor or into its lane's
   band. Only the new node's immediate neighbours may give way; distant shapes are pinned and restored exactly, so an
   edit never tidies the rest of a hand layout. The global layout of pools with lanes computes the rows twice (a
   branch that stays in its lane may continue the row) and keeps the variant with the better score.

6. **Live documents: opt-in tools, retry by re-applying.** `get_process_outline`, `edit_process` and
   `layout_process` register only with `LIVE_MCP_BPMN_EDIT=1`. `edit_process` saves through the ordinary content save
   (validation, CAS, minimal-diff write); on a concurrent change it re-applies the operations to the current text,
   up to three times. `save_bpmn_xml` stays.

## Evidence (2026-09-30)

- **Tool benchmark** (`bench/tool-bench.ts`, 76 files: example repo, fixtures, seeded S/M/L models, customer and
  bpmn-auto-layout material): roundtrip byte-identical 76/76; probe edits with 0 new validator errors and the lane
  kept 68/68; 0 hard layout defects (overlap, flow through shape, node outside its frame); the neighbourhood outline
  of the largest model ~3 KB against ~676 KB of XML. On the largest customer models `tidy` takes ~0.5–0.65 s,
  `layout` ~0.2–0.4 s, an edit 20–100 ms.
- **Real models:** all edit templates on two customer processes (C8, 324/387 KB): 16/16 with the oracle met, no new
  validator error, no collateral change, no new leftward flow and no hard defect.
- **Agent simulation:** 6 tasks, one subagent run per arm (XML editing vs. the edit CLI): both 6/6 correct with 0
  validator errors and 0 collateral; the tool arm used 28 % fewer tokens, 54 % fewer tool calls and 47 % less time,
  with larger XML diffs (the space tool moves the shapes after an insertion). n = 1 per task — a signal, not proof.

## Consequences

- bpmiq stays **design-first**: the core serves every BPMN file, executable or not; adapters grow on demand.
- **Gate:** the `/mcp` tools stay opt-in until the A/B benchmark (`bench/agent/`: 30 tasks with automatic oracles and
  reference solutions, today's XML tools vs. the semantic tools, 5 repetitions) shows no loss in task success, at
  least 20 pp more success on L models, half the tokens on M/L models, no additional collateral change and zero hard
  layout defects. A free dry run proves every oracle sound first; the live run needs API credentials.
- Skills (`new-process`, `import-process`, …) and the web modeler are unchanged until the gate is passed.
- Files not in canonical modeler style are reformatted on their first moddle write and lose XML comments.
- Open for later decisions: a namespaced design spelling (`bpmiq:calledDecision`, schema-valid, changes what the web
  modeler writes), reading Camunda 8 call links (`zeebe:calledElement`) in `notations/extract` (the validator would
  check links it skips today), and adapters for C7 forks with an own namespace.
