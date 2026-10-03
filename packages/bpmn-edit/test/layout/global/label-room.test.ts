import assert from "node:assert/strict";
import { test } from "node:test";

import { layoutGlobally } from "../../../src/layout/global/global.ts";
import { flow, plane, rect } from "../../support/fixtures.ts";
import { boundsOf, event, flows, gateway, task } from "./support.ts";

test("layoutGlobally draws a flow long enough for its label", () => {
  const labelled = plane(
    [event("start", "StartEvent"), gateway("gateway_takeover"), task("task_check"), event("end", "EndEvent")],
    [
      ...flows([
        ["start", "gateway_takeover"],
        ["task_check", "end"],
        ["gateway_takeover", "end"],
      ]),
      {
        ...flow("flow_noTakeover", "gateway_takeover", "task_check", []),
        label: rect(0, 0, 40, 14),
        name: "Keine Ressourcenübernahme möglich",
      },
    ],
  );

  const result = layoutGlobally(labelled);
  const [from, to] = [boundsOf(result, "gateway_takeover"), boundsOf(result, "task_check")];
  const label = result.edges.find((edge) => edge.id === "flow_noTakeover")?.label;

  assert.ok(label);
  assert.ok(label.x >= from.x + from.width && label.x + label.width <= to.x, JSON.stringify({ label, from, to }));
});
