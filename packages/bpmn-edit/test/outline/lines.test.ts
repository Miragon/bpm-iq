import assert from "node:assert/strict";
import { test } from "node:test";

import { lineNumbers } from "../../src/outline/lines.ts";

test("lineNumbers maps each id to the line of its first opening tag and ignores the DI", () => {
  const xml = [
    '<bpmn:definitions id="Definitions_1">',
    '  <bpmn:process id="Process_A">',
    "    <bpmn:task",
    '      id="task_a" name="A" />',
    "  </bpmn:process>",
    '  <bpmndi:BPMNDiagram id="Diagram_1">',
    '    <bpmndi:BPMNShape id="task_a_di" bpmnElement="task_a" />',
  ].join("\n");

  assert.deepEqual(
    [...lineNumbers(xml)],
    [
      ["Definitions_1", 1],
      ["Process_A", 2],
      ["task_a", 3],
    ],
  );
});
