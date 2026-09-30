import assert from "node:assert/strict";
import { test } from "node:test";

import { dockBoundaryEvents } from "../../src/layout/relayout/boundaries.ts";
import { VIRTUAL_END, VIRTUAL_START } from "../../src/layout/relayout/flow-graph.ts";
import { enclosingFragments, findFragment } from "../../src/layout/relayout/fragment.ts";
import { placeInterior } from "../../src/layout/relayout/layered.ts";
import { relayoutVariants } from "../../src/layout/relayout/relayout.ts";
import { shapesById } from "../../src/layout/space.ts";
import { flow, plane, rect, shape } from "../support/fixtures.ts";

// start -> split -> (a | b) -> join -> end
const diamond = plane(
  [
    shape("start", rect(0, 100, 36, 36), { type: "StartEvent" }),
    shape("split", rect(100, 93, 50, 50), { type: "ExclusiveGateway" }),
    shape("task_a", rect(200, 78, 100, 80)),
    shape("task_b", rect(200, 300, 100, 80)),
    shape("join", rect(400, 93, 50, 50), { type: "ExclusiveGateway" }),
    shape("end", rect(500, 100, 36, 36), { type: "EndEvent" }),
  ],
  [
    flow("f1", "start", "split", []),
    flow("f2", "split", "task_a", []),
    flow("f3", "split", "task_b", []),
    flow("f4", "task_a", "join", []),
    flow("f5", "task_b", "join", []),
    flow("f6", "join", "end", []),
  ],
);

const spacing = { columnGap: 50, rowSpacing: 150 };

test("findFragment finds the gateway block around a branch as single entry, single exit fragment", () => {
  const fragment = findFragment(diamond, ["task_a"]);

  assert.equal(fragment.entry, "split");
  assert.equal(fragment.exit, "join");
  assert.deepEqual([...fragment.interior].sort(), ["task_a", "task_b"]);
});

test("findFragment widens to the whole plane when the elements span it", () => {
  const fragment = findFragment(diamond, ["start", "end"]);

  assert.deepEqual([fragment.entry, fragment.exit], [VIRTUAL_START, VIRTUAL_END]);
  assert.equal(fragment.interior.size, 6);
});

test("findFragment rejects an unknown element", () => {
  assert.throws(() => findFragment(diamond, ["nope"]), /no flow node with id 'nope'/);
});

test("placeInterior keeps the upper branch in the entry row and puts the next branch one row below", () => {
  const fragment = findFragment(diamond, ["task_a"]);

  const { centres, exitX } = placeInterior(diamond, fragment, { x: 150, y: 118 }, { columnGap: 50, rowSpacing: 150 });

  assert.deepEqual(centres.get("task_a"), { x: 250, y: 118 });
  assert.deepEqual(centres.get("task_b"), { x: 250, y: 268 });
  assert.equal(exitX, 350);
});

// start -> split -> (task_a | task_b) -> join -> end, and split -> task_c -> end_c, a branch that ends on its own
const withDeadEnd = plane(
  [
    ...diamond.shapes,
    shape("task_c", rect(200, 500, 100, 80)),
    shape("endEvent_c", rect(400, 522, 36, 36), { type: "EndEvent" }),
  ],
  [...diamond.edges, flow("f7", "split", "task_c", []), flow("f8", "task_c", "endEvent_c", [])],
);

test("findFragment finds the gateway block around a branch that only ends in an end event", () => {
  const fragment = findFragment(withDeadEnd, ["task_c"]);

  assert.deepEqual([fragment.entry, fragment.exit], ["split", "join"]);
});

test("findFragment keeps a branch that only ends in an end event inside the gateway block", () => {
  const fragment = findFragment(withDeadEnd, ["task_a"]);

  assert.deepEqual([fragment.entry, fragment.exit], ["split", "join"]);
  assert.deepEqual([...fragment.interior].sort(), ["endEvent_c", "task_a", "task_b", "task_c"]);
});

test("enclosingFragments lists the smallest fragment of every entry around the elements, the whole plane last", () => {
  const nested = plane(
    [...diamond.shapes, shape("outer", rect(-100, 93, 50, 50), { type: "ExclusiveGateway" })],
    [
      flow("f0", "outer", "start", []),
      ...diamond.edges.filter((edge) => edge.id !== "f6"),
      flow("f6", "join", "end", []),
    ],
  );

  const fragments = enclosingFragments(nested, ["task_a"]);

  assert.deepEqual(
    fragments.map((fragment) => [fragment.entry, fragment.exit]),
    [
      ["split", "join"],
      ["start", "join"],
      ["outer", "join"],
      [VIRTUAL_START, VIRTUAL_END],
    ],
  );
});

test("placeInterior keeps a branch drawn above the line above the entry row", () => {
  const above = plane(
    diamond.shapes.map((node) => (node.id === "task_b" ? { ...node, bounds: rect(200, -100, 100, 80) } : node)),
    [...diamond.edges],
  );

  const { centres } = placeInterior(above, findFragment(above, ["task_a"]), { x: 150, y: 118 }, spacing);

  assert.deepEqual(centres.get("task_a"), { x: 250, y: 118 });
  assert.deepEqual(centres.get("task_b"), { x: 250, y: -32 });
});

test("placeInterior puts the branch that rejoins soonest next to the row it branches off from", () => {
  // split -> task_a -> join -> end on the line; below: split -> task_long1 -> task_long2 -> join, split -> task_short -> join
  const branches = plane(
    [
      shape("split", rect(100, 93, 50, 50), { type: "ExclusiveGateway" }),
      shape("task_a", rect(200, 78, 100, 80)),
      shape("task_long1", rect(200, 250, 100, 80)),
      shape("task_long2", rect(400, 250, 100, 80)),
      shape("task_short", rect(200, 400, 100, 80)),
      shape("join", rect(600, 93, 50, 50), { type: "ExclusiveGateway" }),
      shape("end", rect(700, 100, 36, 36), { type: "EndEvent" }),
    ],
    [
      flow("f1", "split", "task_a", []),
      flow("f2", "split", "task_long1", []),
      flow("f3", "task_long1", "task_long2", []),
      flow("f4", "split", "task_short", []),
      flow("f5", "task_a", "join", []),
      flow("f6", "task_long2", "join", []),
      flow("f7", "task_short", "join", []),
      flow("f8", "join", "end", []),
    ],
  );

  const { centres } = placeInterior(branches, findFragment(branches, ["task_a"]), { x: 150, y: 118 }, spacing);

  assert.equal(centres.get("task_short")?.y, 268);
  assert.equal(centres.get("task_long1")?.y, 418);
});

test("dockBoundaryEvents moves a boundary event from the side of its host to the bottom right corner", () => {
  const host = shape("task_host", rect(100, 100, 100, 80));
  const onSide = shape("messageEvent_side", rect(182, 122, 36, 36), { attachedTo: "task_host", type: "BoundaryEvent" });

  const docked = dockBoundaryEvents(plane([host, onSide]), new Set(["task_host"]));

  assert.deepEqual(docked.shapes[1]?.bounds, rect(172, 162, 36, 36));
});

test("dockBoundaryEvents leaves boundary events that already sit on the bottom edge", () => {
  const host = shape("task_host", rect(100, 100, 100, 80));
  const bottom = shape("errorEvent_bottom", rect(120, 162, 36, 36), { attachedTo: "task_host", type: "BoundaryEvent" });

  const docked = dockBoundaryEvents(plane([host, bottom]), new Set(["task_host"]));

  assert.deepEqual(docked.shapes[1]?.bounds, bottom.bounds);
});

test("dockBoundaryEvents lines up several boundary events from the bottom right corner in their order", () => {
  const host = shape("task_host", rect(100, 100, 100, 80));
  const right = shape("messageEvent_right", rect(182, 110, 36, 36), { attachedTo: "task_host", type: "BoundaryEvent" });
  const left = shape("timerEvent_left", rect(82, 130, 36, 36), { attachedTo: "task_host", type: "BoundaryEvent" });

  const docked = dockBoundaryEvents(plane([host, right, left]), new Set(["task_host"]));

  assert.deepEqual(docked.shapes[1]?.bounds, rect(172, 162, 36, 36));
  assert.deepEqual(docked.shapes[2]?.bounds, rect(116, 162, 36, 36));
});

test("relayoutVariants also lays out the enclosing fragment drawn forwards when the smallest one is drawn backwards", () => {
  // start -> outer -> split -> (task_a | task_b) -> join -> last -> end; the block split..join is drawn right to left
  const backwards = plane(
    [
      shape("start", rect(0, 100, 36, 36), { type: "StartEvent" }),
      shape("outer", rect(100, 93, 50, 50), { type: "ExclusiveGateway" }),
      shape("split", rect(700, 93, 50, 50), { type: "ExclusiveGateway" }),
      shape("task_a", rect(500, -100, 100, 80)),
      shape("task_b", rect(500, 300, 100, 80)),
      shape("join", rect(300, -93, 50, 50), { type: "ExclusiveGateway" }),
      shape("last", rect(900, 78, 100, 80)),
      shape("end", rect(1100, 100, 36, 36), { type: "EndEvent" }),
    ],
    [
      flow("f1", "start", "outer", []),
      flow("f2", "outer", "split", []),
      flow("f3", "split", "task_a", []),
      flow("f4", "split", "task_b", []),
      flow("f5", "task_a", "join", []),
      flow("f6", "task_b", "join", []),
      flow("f7", "join", "last", []),
      flow("f8", "last", "end", []),
    ],
  );

  const variants = relayoutVariants(backwards, ["task_a"]);

  // minimal displacement for the backward block, space tool and minimal displacement for the enclosing one
  assert.equal(variants.length, 3);
  const turned = variants.slice(1).map((variant) => shapesById(variant.plane));
  assert.ok(turned.every((byId) => (byId.get("join")?.bounds.x ?? 0) > (byId.get("split")?.bounds.x ?? 0)));
});
