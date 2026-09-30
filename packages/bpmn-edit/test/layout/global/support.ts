/** Shapes and flows for the tests of the global layout. */
import assert from "node:assert/strict";

import type { DiagramEdge, DiagramPlane, DiagramShape } from "../../../src/diagram/plane.ts";
import type { Rect } from "../../../src/geometry/geometry.ts";
import { flow, rect, shape } from "../../support/fixtures.ts";

export const task = (id: string, x = 0, y = 0): DiagramShape => shape(id, rect(x, y, 100, 80));
export const event = (id: string, type: string, x = 0, y = 0): DiagramShape => shape(id, rect(x, y, 36, 36), { type });
export const gateway = (id: string, x = 0, y = 0): DiagramShape =>
  shape(id, rect(x, y, 50, 50), { type: "ExclusiveGateway" });
export const flows = (pairs: readonly (readonly [string, string])[]): DiagramEdge[] =>
  pairs.map(([source, target]) => flow(`flow_${source}To${target}`, source, target, []));

export function boundsOf(result: DiagramPlane, id: string): Rect {
  const bounds = result.shapes.find((candidate) => candidate.id === id)?.bounds;
  assert.ok(bounds, `no shape ${id}`);
  return bounds;
}
