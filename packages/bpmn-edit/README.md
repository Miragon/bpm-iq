# @bpmiq/bpmn-edit

BPMN editing through `bpmn-moddle`, the object model of bpmn-js ([ADR 0008](../../docs/adr/0008-bpmn-editing-through-moddle.md)).
Built for agents working on large models: read a compact outline instead of the XML, change the model through a small
set of semantic operations, let the package compute the geometry. **Isomorphic**: everything exported runs in Node and
in the browser; `src/main.ts` (the CLI) is the only Node entry (`pnpm arch`, rule `bpmn-edit-stays-isomorphic`).

```
node packages/bpmn-edit/src/main.ts outline <file.bpmn> [--around <id>] [--depth <n>] [--bounds] [--full] [--json]
node packages/bpmn-edit/src/main.ts edit    <file.bpmn> --ops <operations.json> [--dry-run] [--json]
node packages/bpmn-edit/src/main.ts layout  <file.bpmn> --mode tidy|relayout|layout [--scope <id>[,<id>...] | --plane <id>] [--dry-run] [--json]
node packages/bpmn-edit/src/main.ts metrics <file.bpmn> [--json]
```

Exit codes: 0 done, 2 usage error, an unreadable file, an unknown element or a failing operation. `edit` and `layout`
write the file unless `--dry-run` is given; both print what changed and the metrics of the touched planes before and
after. After a model edit run `pnpm validate` (hard rule 1).

On live documents the same functions sit behind three MCP tools of the live host — `get_process_outline`,
`edit_process`, `layout_process` — registered only with `LIVE_MCP_BPMN_EDIT=1` until the A/B gate of ADR 0008 is
passed (see Benchmark below). `edit_process` saves through the ordinary content save (validation, CAS, minimal-diff
write) and re-applies its operations when a co-editor changed the document in between.

## Design core and platforms

The platform of a file is **detected, never imposed** (`src/platform/detect.ts`): `modeler:executionPlatform`
("Camunda Platform" → `c7`, "Camunda Cloud" → `c8`), else the engine namespace the file actually uses, else `design`.

| Layer                                | Writes                                                                                                                           |
| ------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------- |
| design core (every file)             | structure, lanes, BPMNDI and layout, names, conditions, error boundaries, call links (`calledElement`), decision links           |
| `c7` adapter (`camunda-bpmn-moddle`) | `camunda:inputOutput`, `camunda:decisionRef`, `camunda:modelerTemplate`                                                          |
| `c8` adapter (`zeebe-bpmn-moddle`)   | `zeebe:ioMapping`, `zeebe:taskHeaders`, `zeebe:calledDecision`, `zeebe:calledElement`, `zeebe:userTask`, `zeebe:modelerTemplate` |

The core never writes a platform extension and never drops a foreign one: whatever no loaded descriptor knows (bpmiq
stickies, vendor extensions, the unprefixed `calledDecision`) passes through untouched, and namespace declarations of
the root survive a write even when nothing uses them. Edits follow the file: a new decision link uses the spelling the
file already uses (else the platform's: `calledDecision` in design models), new nodes join their anchor's lane, flow
ids follow the file's style (`Flow_<hash>` beside modeler ids, `flow_xToY`, else `<Prefix>_<source>_to_<target>`), DI
ids too (`Shape_<id>` / `<id>_di`), and `<bpmn:incoming>`/`<bpmn:outgoing>` lists are kept only where the file keeps
them (`sourceRef`/`targetRef` are the truth). bpmiq stickies follow the flow node nearest to them when a layout moves it.

## Outline

Every process with its lanes, its flow elements (sub-process children flattened, with `parent`) and sequence flows,
without DI, one line per element and flow, each with the line of its opening tag in the XML. Valid YAML; `--json`
prints the same data as JSON.

```yaml
platform: design
processes:
  - process: order-to-cash
    name: "Order to Cash"
    lanes:
      Lane_order_management: { name: "Order Management" }
    elements:
      Task_check_credit:
        {
          type: businessRuleTask,
          name: "Check credit limit",
          line: 29,
          lane: Lane_order_management,
          calledDecision: "credit-limit-check",
        }
      Gateway_credit_approved:
        { type: exclusiveGateway, name: "Credit approved?", line: 33, lane: Lane_order_management }
    flows:
      Flow_yes: { from: Gateway_credit_approved, to: Task_fulfill_order, name: "yes", line: 44 }
```

| Option          | Effect                                                                                                                                                                           |
| --------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `--around <id>` | only the element, its neighbours along sequence flows (both directions, a boundary event and its host count as neighbours) and the flows between them; `omitted` counts the rest |
| `--depth <n>`   | flow steps around `--around`, default 2                                                                                                                                          |
| `--bounds`      | the DI bounds of every element as `[x, y, width, height]`                                                                                                                        |
| `--full`        | values longer than 80 characters in full instead of shortened (`...(+n chars)`)                                                                                                  |

Element fields, when present: `type`, `name`, `line`, `parent`, `lane`, `attachedTo`, `trigger` (event definition
with its error code, timer, message or signal), `calledElement`, `calledDecision` (every spelling), and — in a C7/C8
model — `template`, `taskType`, `inputs`, `outputs`, `headers`, `script`, `resultVariable`, `formId`, `assignment`;
plus `default` and `bounds`.

## Edit: operations

A JSON array of operations (or a single one), applied in order, all or nothing. A failing operation names its index
and the reason; nothing is written then.

| Operation               | Fields                                                           | Effect                                                                                                                                                           |
| ----------------------- | ---------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `insertAfter`           | `after`, `element`, `via?`, `branch?`, `name?`, `condition?`     | new flow node after `after`: into its outgoing flow (the only one, or `via`); with `branch` (implied for an end event) on a new outgoing flow, named/conditioned |
| `insertBetween`         | `flow`, `element`                                                | the same, named by the flow to split                                                                                                                             |
| `remove`                | `id`, `reconnect?`                                               | a flow node with its flows, boundary events and lane membership (or a single flow); `reconnect` joins its only predecessor and successor                         |
| `connect`               | `from`, `to`, `id?`, `name?`, `condition?`                       | new sequence flow, routed                                                                                                                                        |
| `addErrorBoundary`      | `attachTo`, `id`, `name`, `errorCode`, `to` or `end: {id, name}` | error boundary event on the activity (beside existing ones), the `bpmn:Error` (created when missing) and the flow to `to` or to a new end event                  |
| `rename`                | `id`, `name`                                                     | new name, label resized                                                                                                                                          |
| `changeType`            | `id`, `type`                                                     | a task kind for a task kind, a gateway kind for a gateway kind; id, name, flows, lane, boundary events and shape stay                                            |
| `setCondition`          | `flow`, `condition`                                              | condition expression; `null` removes it; a default flow takes none                                                                                               |
| `setDefault`            | `gateway`, `flow`                                                | default flow of a gateway (its condition is removed)                                                                                                             |
| `addLane`               | `id`, `name`, `process?`                                         | a role at the bottom of the pool; the first lane of a process takes every node                                                                                   |
| `moveToLane`            | `id`, `lane`                                                     | the node (with its boundary events) changes its role; the shape moves into the lane's band                                                                       |
| `setCalledElement`      | `id`, `process`                                                  | call link of a call activity; `null` removes it                                                                                                                  |
| `setCalledDecision`     | `id`, `decision`                                                 | decision link of a business rule task; `null` removes it                                                                                                         |
| `setInput`, `setOutput` | `id`, `target`, `source`                                         | C7/C8 only: variable mapping; `source: null` removes it                                                                                                          |
| `setHeader`             | `id`, `key`, `value`                                             | C8 only: task header; `value: null` removes it                                                                                                                   |

`element` is `{ "type", "id", "name", "row"?: "same" | "below" | "bottom", "lane"?, "calledElement"?, "calledDecision"?,
"template"?: { "id", "version" } }` (template: C7/C8 only) with `type` one of `task`, `userTask`, `serviceTask`,
`scriptTask`, `sendTask`, `receiveTask`, `manualTask`, `businessRuleTask`, `callActivity`, `exclusiveGateway`,
`parallelGateway`, `inclusiveGateway`, `intermediateCatchEvent`, `intermediateThrowEvent`, `endEvent`.

```json
[
  {
    "op": "insertAfter",
    "after": "Task_fulfill_order",
    "element": { "type": "userTask", "id": "Task_ship", "name": "Ship goods" }
  },
  {
    "op": "insertAfter",
    "after": "Gateway_credit_approved",
    "branch": true,
    "name": "unclear",
    "element": {
      "type": "userTask",
      "id": "Task_clarify",
      "name": "Clarify credit",
      "lane": "Lane_billing",
      "row": "bottom"
    }
  },
  {
    "op": "addErrorBoundary",
    "attachTo": "Task_ship",
    "id": "Event_lost",
    "name": "Parcel lost",
    "errorCode": "LOST",
    "end": { "id": "End_lost", "name": "Parcel lost" }
  }
]
```

Geometry keeps the reading order (left to right, else top to bottom), like a modeler user with the space tool: an
element inserted into a flow makes the rest of the sequence move one column on and takes the row that flow leads into
(the target's place when the target stood below the anchor); a branch goes into the next column, below the anchor, at
the bottom of its frame or into its lane's band. Only the new element's immediate neighbours give way — distant shapes
stay exactly where they are, even where the hand layout was cramped. Created and reconnected flows are routed, labels
placed. Distances are taken from the plane (median of its column gaps and row distances), so an edit fits the hand
layout. A second flow into (or out of) an element that is no gateway is allowed but reported (bpmnlint `fake-join` /
implicit split).

## Layout

| Mode       | What it does                                                                                                                                                   |
| ---------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `tidy`     | keeps the drawing: removes overlaps and gaps below 20 px with minimal displacement in unchanged order, reroutes the flows of moved shapes, closes empty strips |
| `relayout` | lays out the smallest single-entry single-exit fragment around `--scope` (or the whole plane) anew, left to right; the rest makes room                         |
| `layout`   | lays out every plane (or `--plane`) completely anew, left to right; for messy models whose hand layout is not worth keeping                                    |

Only the DI changes: names, ids and flows stay, collapsed sub-processes keep their plane. `computeLayout`
(`src/layout/layout.ts`) returns the result as geometry only (`shapes`, `edges`, `labels`, `diagnostics`).

### Score and choice

`tidy` and `relayout` compute variants and keep one only when it lowers the score of its plane and passes the hard
limits (`score.ts`, `choice.ts`). The score weighs, in this order: shape overlaps and nodes outside their lane or
pool, flows through shapes, crossings, flows against the reading direction, flows on top of each other and rule
breaks, covered labels, gaps, bends and length. The hard limits compare from the most severe defect down (overlaps,
nodes outside their frame, flows through shapes, crossings): a lighter defect is allowed only where it removes a
more severe one. A hand layout is therefore never replaced by a worse one; otherwise the plane stays and a note says
so. `layout` always replaces the plane (it was asked for) and notes a hard limit that got worse.

### tidy

1. Separation (`vpsc.ts`, `tidy.ts`): VPSC (variable placement with separation constraints, WebCola) on x and y with
   20 px between shapes and the borders of pools, lanes and expanded sub-processes as variables (`frames.ts`); a flow
   node keeps 20 px inside its innermost frame, a crowded frame grows and pushes the ones below. Levels go from the
   inside out: the content of the deepest sub-process first, then the sub-process as one shape of its new size.
   Boundary events follow their host; shifts up to 5 px that the distance does not need are taken back.
2. Flows (`reroute.ts`, `stretch.ts`): a moved end stretches the next segment where it can, other flows are routed
   anew; loose or diagonal flows are always rerouted.
3. Rules where they add no defect: flows leave a gateway right, up or down (`fixSides`); end events stand in one
   column on the right of their pool, plane or sub-process (`end-events.ts`).
4. Empty strips (`compact.ts`): a strip without shape, label or bend wider than twice the gap closes to the gap by
   the space tool (`space.ts`, which resizes a container across the line and moves those beyond it).

### relayout

`relayout/fragment.ts` finds the fragment: its entry dominates the scope, its exit closes the smallest block that
every flow in and out passes; branches that only end in end events belong to it (dead ends), an end event is never
an exit, and a fragment drawn backwards also tries its smallest forward enclosing fragment. `relayout/layered.ts`
lays it out with the column and row steps of the global layout (below), docks boundary events at the bottom right
and puts the exit on the line of the entry. The plane makes room by the space tool or by separation, whichever
scores better; variants end with separation and empty strips.

### layout (global, `src/layout/global/`)

A Sugiyama layout per level: the plane, every pool, every expanded sub-process from the inside out (a sub-process
then counts as one node of its laid out size).

1. Loop returns (`feedback.ts`): a depth-first search from the start events; a flow back to a node the search is
   still inside of is a loop return, the only flow allowed to run right to left.
2. Columns (`columns.ts`): longest path over the other flows, end events in the last column.
3. Rows (`rows.ts`, `crossings.ts`): the successor with the longest way ahead continues the row, a join returns to
   the oldest row of its predecessors, every other branch opens a row next to its origin, shorter branches nearer. A
   branch that leads to a loop return goes outermost below, so the return passes under everything. Each branch takes
   the side with fewer crossings; rows in separate columns share a height (skyline). With lanes the rows are computed
   twice — a branch that stays in its lane may also continue the row while the others leave for their bands — and the
   variant with the better score is kept (only when some node has successors in its own and in another lane).
4. Coordinates (`coordinates.ts`, `pools.ts`): columns as wide as their widest node plus 100 px, rows 150 px apart,
   nodes centred; the gap before a column widens until the label of a flow from the previous column fits on its line
   (`level.ts`). Lanes are bands with their own rows and 40 px padding, pools stack, nodes without flows go into a
   row below.
5. Artifacts and boundary events (`artifacts.ts`, `relayout/boundaries.ts`): annotations and data objects keep their
   offset to their node, boundary events dock at the bottom right of their host.
6. Flows (`routing.ts`, `loops.ts`): old routes are dropped; loop returns take a channel below the content of their
   innermost frame (out of a gateway or event downwards, of an activity to the right); then all other flows; flows on
   top of each other and branches that fork too late are routed once more; each flow in a crossing gets one more try,
   kept when crossings drop.
7. Labels, then `tidy` for anything left over, then the flow labels once more.

### Routing (`src/layout/router/`)

Orthogonal routes on a grid of all obstacle borders (Wybrow et al., Orthogonal Connector Routing, 2009) with A*.
Cost: length, 150 px per bend, 200 per crossing, 300 per grid step on another flow or on the border of a pool, lane
or sub-process; flows into the same target and forward branches of the same source may share their way. Routes keep
30 px to the shapes they pass and start and end with a stub of that length; shapes facing each other connect
straight.

Ports (`ports.ts`, `branches.ts`): activities are entered left and left right, gateways left right (preferred), up or
down, events as needed, boundary events downwards. Two flows never leave one shape by the same top or bottom side;
further branches share the right side as a trunk. A branch alone on the right runs straight and turns at its target;
a branch sharing the right side forks 30 px behind the gateway (the fork costs one bend, so a free top or bottom side
stays as cheap). A gateway or event with a loop return lets only the loop leave downwards; a gateway with three
forward branches or more leaves them all to the right.

### Labels (`labels.ts`, `label-size.ts`)

Size: bpmn-js wraps a label at its DI width (at least 90 px) and then again at the width of its longest line, which
can turn two lines into three or four. `label-size.ts` simulates both passes (diagram-js `layoutNext` with the Arial
advance widths) and takes the narrowest width at which the lines hold, broken between words, with the measured
widths up to 3 % off: shape labels on at most two lines, flow labels on one, at most 240 px. Where no place is free,
the label tries once more on one line more.

Place: the first candidate without a foreign shape, flow or label within 8 px, else the one with the fewest conflicts.
The question of a gateway hangs 4 px above it, else below it, before it only when flows leave at top and bottom; a
boundary event label stands right beside the event below the border of its host; other event labels below, above,
beside or at a corner. A flow label stands 8 px beside its line from where it leaves the trunk of its source, on the
horizontal segment first, so the labels of all branches line up behind the fork. A label more than 60 px from its
element is always placed anew.

### Result

On the 49 examples of bpmn-auto-layout and two large customer models (125 and 105 flow nodes per plane), `layout`
leaves no shape overlap, no flow through a shape, no node outside its frame, no gap below 20 px and no left-running
flow except loop returns; 22 crossings and 4 labels touching a flow in total; every label is drawn by bpmn-js with
the lines of its DI; about 0.6 s per file.

Limits: `tidy` and `relayout` keep a hand layout when a fragment is unstructured (jumps between branches, long loops),
since a new layout rarely scores better; turning backward drawn parts around makes a plane wider. Text inside shapes
is not measured, and a single word whose width is a whole pixel breaks in bpmn-js itself.

## Metrics

| Column                      | Meaning                                                                                                                                                                    |
| --------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `shapes`, `edges`, `labels` | shapes, flow connections (sequence and message flows) and external labels with DI bounds                                                                                   |
| `shpOvl`                    | pairs of shapes that overlap; containers (pools, lanes, groups, expanded sub-processes) and a boundary event on its host do not count                                      |
| `gap<20`                    | pairs of shapes closer than 20 px                                                                                                                                          |
| `lblOvl`                    | label-shape, label-flow and label-label pairs that overlap; a label may touch its own element and its own flow                                                             |
| `cross`                     | pairs of flows that properly cross; flows with a common source or target do not count                                                                                      |
| `edgOvl`                    | pairs of flows that run on top of each other for more than 2 px; flows into the same target may share their last stretch, the branches of a split the trunk they fork from |
| `through`                   | pairs of flow and foreign shape where the flow runs through the shape                                                                                                      |
| `bends`                     | changes of direction over all flows                                                                                                                                        |
| `length`                    | total length of all flows in px                                                                                                                                            |
| `back`                      | sequence flows that end left of their start                                                                                                                                |
| `side`                      | sequence flows that leave their source on a side it may not be left by (an activity elsewhere than right, a gateway to the left)                                           |
| `endCol`                    | end events not in the one column on the right of their pool (or plane)                                                                                                     |
| `outLane`                   | flow nodes whose centre lies outside their expanded sub-process, their lane or (without one) their pool                                                                    |
| `width`, `height`           | extent of shapes, labels and waypoints in px                                                                                                                               |

The metrics complement the platform validator (`pnpm validate`) and the rendering in the web modeler.

## Roundtrip

`src/model/document.ts` parses and serializes through the same object model as the modeler. A file in the canonical
style of the modeler serializes back byte for byte — every model of `process-documentation`, the fixtures (design,
Camunda 7, Camunda 8) and 76 of 76 files of the benchmark corpus; a test guards that. **XML comments and hand
formatting are not preserved**: an edit rewrites such a file in the canonical style and drops its comments (`edit`
says so).

## Benchmark

**Tool benchmark** (`bench/tool-bench.ts`, deterministic, offline): outline size, roundtrip fidelity, runtime, layout
metrics before/after `tidy` and `layout`, and a probe edit checked by the platform validator, over the example
content repo, the fixtures, a seeded S/M/L corpus (`bench/generate.ts`) and every directory in `BPMN_BENCH_CORPUS`
(local material that is not committed).

```
BPMN_BENCH_CORPUS=<dir>[:<dir>...] node packages/bpmn-edit/bench/tool-bench.ts [--seeds 5] [--json <file>]
```

**A/B benchmark** (`bench/agent/`, the gate of ADR 0008): 30 tasks (9 edit templates on an S, M and L model, 3
scaffolds), each with a prompt in the words of a process owner, an automatic oracle, a list of what it may change
(everything else counts as collateral) and a reference solution. Arm A gets today's XML tools, arm B the semantic
tools (XML as a recorded fallback), same model, same prompt.

```
node packages/bpmn-edit/bench/agent/prepare.ts <dir>          # the content repo; prints the live-host command
node packages/bpmn-edit/bench/agent/run.ts --dry-run          # free: every oracle fails before and passes on the reference
node packages/bpmn-edit/bench/agent/run.ts --out runs.jsonl   # costs API tokens (ANTHROPIC_API_KEY)
node packages/bpmn-edit/bench/agent/report.ts runs.jsonl --md report.md
```

The report gives success rates with Wilson 95 % intervals, paired per-task changes of tokens, cost, time and turns
(median, bootstrap 95 % interval, Wilcoxon p), collateral changes, first-save validity and hard layout defects per
size, and the go/no-go verdict of the gate criteria fixed in ADR 0008.

## Development

TypeScript executed directly by Node (type stripping; hence `.ts` imports and no parameter properties).
`pnpm --filter @bpmiq/bpmn-edit test` runs the tests below `test/`; `typecheck` runs `tsc --noEmit`. Tests on a large
local model run only when `BPMN_EDIT_LARGE_MODEL` names one. Dependencies: `bpmn-moddle`, `camunda-bpmn-moddle`,
`zeebe-bpmn-moddle`, `webcola` (MIT, VPSC only).

```
src/index.ts                the browser-safe API
src/main.ts                 the CLI: command, output, exit code
src/platform/               platform detection, design core vs C7/C8 adapters, extension helpers
src/model/document.ts       parse and serialize through bpmn-moddle (roundtrip)
src/outline/                outline: elements, XML lines, neighbourhood window, YAML
src/operations/             operations: parsing, semantic changes, lanes, DI of new elements, geometry of an edit
src/layout/                 modes, score and choice, separation (VPSC, frames), space tool, empty strips, labels
src/layout/relayout/        fragment, layering, spacing, boundary events
src/layout/global/          global layout: loop returns, columns, rows, crossings, coordinates, pools, loops, routing
src/layout/router/          A* router, ports, branches and forks
src/diagram/                DI planes as plain data, pool, lane and sub-process membership
src/geometry/               rectangles, segments, crossings, overlaps, shared starts of routes
src/metrics/                shape, edge and label metrics, composition, table
bench/                      tool benchmark, seeded corpus generator, A/B agent benchmark
```
