import assert from "node:assert/strict";
import { test } from "node:test";

import type { Outline } from "../../src/outline/types.ts";
import { formatYaml } from "../../src/outline/yaml.ts";

test("formatYaml writes one line per element and flow, quoting everything that is not a plain identifier", () => {
  const outline: Outline = {
    platform: "c8",
    processes: [
      {
        id: "Process_A",
        name: 'Process "A"',
        lanes: [{ id: "Lane_sales", name: "Sales" }],
        elements: [
          {
            id: "serviceTask_a",
            type: "serviceTask",
            name: "Do: a",
            line: 3,
            lane: "Lane_sales",
            template: { id: "T", version: "2" },
            inputs: { "x.y": "=a > 1" },
            bounds: { x: 1, y: 2, width: 3, height: 4 },
          },
          { id: "no", type: "endEvent" },
        ],
        flows: [{ id: "flow_a", from: "serviceTask_a", to: "no", condition: "=x", line: 9 }],
        omitted: { elements: 2, flows: 1 },
      },
    ],
  };

  assert.deepEqual(formatYaml(outline), [
    "platform: c8",
    "processes:",
    "  - process: Process_A",
    '    name: "Process \\"A\\""',
    "    lanes:",
    '      Lane_sales: {name: "Sales"}',
    "    elements:",
    '      serviceTask_a: {type: serviceTask, name: "Do: a", line: 3, lane: Lane_sales, template: "T@2", inputs: {x.y: "=a > 1"}, bounds: [1, 2, 3, 4]}',
    '      "no": {type: endEvent}',
    "    flows:",
    '      flow_a: {from: serviceTask_a, to: "no", condition: "=x", line: 9}',
    "    omitted: {elements: 2, flows: 1}",
  ]);
});

test("formatYaml writes empty sections as empty mappings", () => {
  assert.deepEqual(formatYaml({ platform: "design", processes: [{ id: "Process_Empty", elements: [], flows: [] }] }), [
    "platform: design",
    "processes:",
    "  - process: Process_Empty",
    "    elements: {}",
    "    flows: {}",
  ]);
});
