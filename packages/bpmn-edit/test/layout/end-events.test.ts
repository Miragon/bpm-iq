import assert from "node:assert/strict";
import { test } from "node:test";

import { alignEndEvents } from "../../src/layout/end-events.ts";
import { fixSides } from "../../src/layout/reroute.ts";
import { countEndEventsOffColumn, countWrongSides } from "../../src/metrics/rules.ts";
import { flow, plane, rect, shape } from "../support/fixtures.ts";

const task = shape("task_work", rect(100, 78, 100, 80));

test("alignEndEvents puts the end events in one column right of everything else, each on its own height", () => {
  const near = shape("endEvent_near", rect(250, 100, 36, 36), { type: "EndEvent" });
  const far = shape("endEvent_far", rect(600, 300, 36, 36), { type: "EndEvent" });
  const other = shape("task_other", rect(300, 278, 100, 80));
  const layout = plane(
    [task, other, near, far],
    [
      flow("flow_workToNear", "task_work", "endEvent_near", [
        { x: 200, y: 118 },
        { x: 250, y: 118 },
      ]),
      flow("flow_otherToFar", "task_other", "endEvent_far", [
        { x: 400, y: 318 },
        { x: 600, y: 318 },
      ]),
    ],
  );

  const { plane: aligned, moved } = alignEndEvents(layout);
  const [nearAfter, farAfter] = [aligned.shapes[2], aligned.shapes[3]];

  assert.deepEqual([...moved].sort(), ["endEvent_far", "endEvent_near"]);
  assert.equal(nearAfter?.bounds.x, farAfter?.bounds.x);
  assert.ok((nearAfter?.bounds.x ?? 0) > 400);
  assert.deepEqual([nearAfter?.bounds.y, farAfter?.bounds.y], [100, 300]);
  assert.equal(countEndEventsOffColumn(aligned), 0);
});

test("alignEndEvents leaves an end event where moving it would cross a flow", () => {
  const end = shape("endEvent_blocked", rect(250, 100, 36, 36), { type: "EndEvent" });
  const upper = shape("task_upper", rect(400, -200, 100, 80));
  const lower = shape("task_lower", rect(400, 300, 100, 80));
  const layout = plane(
    [task, end, upper, lower],
    [
      flow("flow_workToEnd", "task_work", "endEvent_blocked", [
        { x: 200, y: 118 },
        { x: 250, y: 118 },
      ]),
      // a flow down from the upper to the lower task, right through the row of the end event
      flow("flow_upperToLower", "task_upper", "task_lower", [
        { x: 500, y: -160 },
        { x: 520, y: -160 },
        { x: 520, y: 340 },
        { x: 500, y: 340 },
      ]),
    ],
  );

  const { moved } = alignEndEvents(layout);

  assert.equal(moved.size, 0);
});

test("fixSides lets a flow that leaves a gateway to the left leave it on an allowed side", () => {
  const gateway = shape("gateway_split", rect(100, 93, 50, 50), { type: "ExclusiveGateway" });
  const upper = shape("task_upper", rect(250, -80, 100, 80));
  const layout = plane(
    [gateway, upper],
    [
      flow("flow_splitToUpper", "gateway_split", "task_upper", [
        { x: 100, y: 118 },
        { x: 80, y: 118 },
        { x: 80, y: -40 },
        { x: 250, y: -40 },
      ]),
    ],
  );

  const { plane: fixed, rerouted } = fixSides(layout);

  assert.equal(countWrongSides(layout), 1);
  assert.deepEqual([...rerouted], ["flow_splitToUpper"]);
  assert.equal(countWrongSides(fixed), 0);
  assert.notEqual(fixed.edges[0]?.waypoints[0]?.x, 100);
});
