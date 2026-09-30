/**
 * Where a flow may leave and enter a shape (the rule flow-connection-side): activities are entered from the left and
 * left to the right, a boundary event is left downwards, a gateway is left to the right (preferred), upwards or
 * downwards, so its branches visibly start at the gateway, and entered from any side; events may use other sides as
 * well.
 */
import type { DiagramShape } from "../../diagram/plane.ts";
import type { Point, Rect } from "../../geometry/geometry.ts";
import { type Kind, kindOf } from "../constants.ts";

/** The four directions of an orthogonal route. */
const DIRECTION = { right: 0, down: 1, left: 2, up: 3 } as const;

export type Direction = (typeof DIRECTION)[keyof typeof DIRECTION];

export const RIGHT: Direction = DIRECTION.right;
export const DOWN: Direction = DIRECTION.down;
export const LEFT: Direction = DIRECTION.left;
export const UP: Direction = DIRECTION.up;
export const DIRECTIONS: readonly Direction[] = [RIGHT, DOWN, LEFT, UP];

export const VECTORS: Readonly<Record<Direction, Point>> = {
  [DIRECTION.right]: { x: 1, y: 0 },
  [DIRECTION.down]: { x: 0, y: 1 },
  [DIRECTION.left]: { x: -1, y: 0 },
  [DIRECTION.up]: { x: 0, y: -1 },
};

/** The reverse direction: the directions run clockwise from 0 (right), so the opposite is two steps on. */
export function opposite(direction: Direction): Direction {
  return ((direction + 2) & 3) as Direction;
}

/** A docking point on the border of a shape and the direction pointing away from the shape. */
export interface Port {
  readonly point: Point;
  readonly direction: Direction;
}

function sidePort(rect: Rect, direction: Direction): Port {
  const centre = { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 };
  const vector = VECTORS[direction];
  return {
    point: {
      x: Math.round(centre.x + (vector.x * rect.width) / 2),
      y: Math.round(centre.y + (vector.y * rect.height) / 2),
    },
    direction,
  };
}

const ALL_SIDES: readonly Direction[] = [RIGHT, DOWN, UP, LEFT];
const SOURCE_SIDES: Readonly<Record<Kind, readonly Direction[]>> = {
  activity: [RIGHT],
  event: [RIGHT, DOWN, UP],
  gateway: [RIGHT, DOWN, UP],
  other: ALL_SIDES,
};
const TARGET_SIDES: Readonly<Record<Kind, readonly Direction[]>> = {
  activity: [LEFT],
  event: [LEFT, UP, DOWN],
  gateway: [LEFT, UP, DOWN, RIGHT],
  other: [LEFT, UP, DOWN, RIGHT],
};

/** The sides a flow may leave the shape by, in order of preference. */
export function sourcePorts(shape: DiagramShape): Port[] {
  const sides = shape.attachedTo ? [DOWN] : SOURCE_SIDES[kindOf(shape.type)];
  return sides.map((side) => sidePort(shape.bounds, side));
}

/** The sides a flow may enter the shape by, in order of preference; the direction points away from the shape. */
export function targetPorts(shape: DiagramShape): Port[] {
  return TARGET_SIDES[kindOf(shape.type)].map((side) => sidePort(shape.bounds, side));
}

/** How far the start of a flow may lie from a port and still count as docked there. */
const DOCK_TOLERANCE = 2;

/** True when a flow starting at `point` leaves the shape on a side it may be left by. */
export function leavesAllowedSide(shape: DiagramShape, point: Point): boolean {
  return sourcePorts(shape).some(
    (port) => Math.abs(port.point.x - point.x) <= DOCK_TOLERANCE && Math.abs(port.point.y - point.y) <= DOCK_TOLERANCE,
  );
}
