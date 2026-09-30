// The large test model of the layout work is local material that is not committed; the test runs only where
// BPMN_EDIT_LARGE_MODEL names it.
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { test } from "node:test";

import { measure } from "../../src/metrics/metrics.ts";
import { LARGE_MODEL } from "../support/fixtures.ts";

const TEST_MODEL = LARGE_MODEL;

test(
  "measures every plane of the large test model",
  { skip: !(TEST_MODEL && existsSync(TEST_MODEL)) && "BPMN_EDIT_LARGE_MODEL not set" },
  async () => {
    const metrics = await measure(readFileSync(TEST_MODEL, "utf8"), TEST_MODEL);

    assert.equal(metrics.length, 7);
    assert.ok(metrics.every((plane) => plane.shapes > 0 && plane.edges > 0));
  },
);
