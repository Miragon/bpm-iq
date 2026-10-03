import assert from "node:assert/strict";
import { test } from "node:test";

import { legacyCopies } from "../../legacy-settings.ts";

const URL_A = "https://live.example.com";
const URL_B = "http://localhost:9000";

test("legacyCopies: a legacy value lands at its own target", () => {
  assert.deepEqual(legacyCopies({ globalValue: URL_A }, {}), [{ target: "global", value: URL_A }]);
  assert.deepEqual(legacyCopies({ workspaceValue: URL_A }, {}), [{ target: "workspace", value: URL_A }]);
  assert.deepEqual(legacyCopies({ globalValue: URL_A, workspaceValue: URL_B }, {}), [
    { target: "global", value: URL_A },
    { target: "workspace", value: URL_B },
  ]);
});

test("legacyCopies: never over a value the new key already holds at that target", () => {
  assert.deepEqual(legacyCopies({ globalValue: URL_A }, { globalValue: URL_B }), []);
  // a workspace value of the new key does not block the user-level copy
  assert.deepEqual(legacyCopies({ globalValue: URL_A }, { workspaceValue: URL_B }), [
    { target: "global", value: URL_A },
  ]);
});

test("legacyCopies: nothing to carry over", () => {
  assert.deepEqual(legacyCopies(undefined, undefined), []);
  assert.deepEqual(legacyCopies({}, {}), []);
});
