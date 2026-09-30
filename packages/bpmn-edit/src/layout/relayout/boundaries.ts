/**
 * Boundary events of a laid out activity go to its bottom edge, the rightmost at the bottom right corner
 * (layout-geometry.md): the right side stays free for the outgoing flow, and the flows of the events leave downwards
 * into the rows the layering opens below the host.
 */
import type { DiagramPlane, DiagramShape } from "../../diagram/plane.ts";
import { EPSILON } from "../../geometry/geometry.ts";
import { BOUNDARY_FROM_BOTTOM, BOUNDARY_FROM_RIGHT, MIN_SHAPE_GAP, SIZES } from "../constants.ts";
import { moveShape, shapesById } from "../space.ts";

/** Distance between the left edges of two neighbouring boundary events on one edge: a width plus the minimum gap. */
const BOUNDARY_STEP = SIZES.event.width + MIN_SHAPE_GAP;

function onBottomEdge(event: DiagramShape, host: DiagramShape): boolean {
  return Math.abs(event.bounds.y + event.bounds.height / 2 - (host.bounds.y + host.bounds.height)) < EPSILON;
}

/**
 * Moves of the boundary events of one host, right to left in their current order; none if all sit at the bottom,
 * unless `always` asks to dock them anew.
 */
function docking(
  host: DiagramShape,
  events: readonly DiagramShape[],
  always: boolean,
): [string, readonly [number, number]][] {
  if (!always && events.every((event) => onBottomEdge(event, host))) {
    return [];
  }
  const y = host.bounds.y + host.bounds.height - BOUNDARY_FROM_BOTTOM;
  return [...events]
    .sort((first, second) => second.bounds.x - first.bounds.x)
    .map((event, index) => {
      const x = host.bounds.x + host.bounds.width - BOUNDARY_FROM_RIGHT - index * BOUNDARY_STEP;
      return [event.id, [x - event.bounds.x, y - event.bounds.y]];
    });
}

export function dockBoundaryEvents(plane: DiagramPlane, hosts: ReadonlySet<string>, always = false): DiagramPlane {
  const byId = shapesById(plane);
  const moves = new Map(
    [...hosts].flatMap((id) => {
      const host = byId.get(id);
      return host
        ? docking(
            host,
            plane.shapes.filter((shape) => shape.attachedTo === id),
            always,
          )
        : [];
    }),
  );
  return {
    ...plane,
    shapes: plane.shapes.map((shape) => {
      const [dx, dy] = moves.get(shape.id) ?? [0, 0];
      return dx === 0 && dy === 0 ? shape : moveShape(shape, dx, dy);
    }),
  };
}
