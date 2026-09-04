import assert from "node:assert/strict";
import { test } from "node:test";

import { mcpAppToolName } from "../src/mcp-app.ts";

test("mcpAppToolName: the two wire-pinned names stay, every other notation is generated from its id", () => {
  assert.equal(mcpAppToolName("bpmn"), "open_modeler");
  assert.equal(mcpAppToolName("dmn"), "open_decision_modeler");
  assert.equal(mcpAppToolName("wardley"), "open_wardley_modeler");
  assert.equal(mcpAppToolName("team-topology"), "open_team_topology_modeler");
  assert.equal(mcpAppToolName("event-storming"), "open_event_storming_modeler");
  // own-property gate: prototype members never resolve as a pinned name
  assert.equal(mcpAppToolName("toString"), "open_toString_modeler");
});
