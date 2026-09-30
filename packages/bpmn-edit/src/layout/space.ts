/**
 * Geometry helpers on a diagram plane and the space tool: everything beyond a line (or, with side 'before', in
 * front of it) moves by a distance, the way the space tool of the modeler works. Flows keep their shape because only
 * the waypoints on the moving side move.
 */
import type { DiagramEdge, DiagramPlane, DiagramShape } from "../diagram/plane.ts";
import type { Point, Rect } from "../geometry/geometry.ts";

export type Axis = "x" | "y";

/** Where a line of the space tool moves things: at and beyond it (right, down) or at and in front of it. */
export interface Space {
  readonly axis: Axis;
  readonly line: number;
  readonly delta: number;
  readonly side?: "after" | "before";
}

export function center(rect: Rect): Point {
  return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 };
}

export function translate<T extends Point>(value: T, dx: number, dy: number): T {
  return { ...value, x: value.x + dx, y: value.y + dy };
}

export function shapesById(plane: DiagramPlane): Map<string, DiagramShape> {
  return new Map(plane.shapes.map((shape) => [shape.id, shape]));
}

/** The shapes a flow may touch: its source and target, and the host when one of them is a boundary event. */
export function endsOf(plane: DiagramPlane, edge: DiagramEdge): Set<string | undefined> {
  const hosts = new Map(plane.shapes.map((shape) => [shape.id, shape.attachedTo]));
  return new Set([edge.source, edge.target, hosts.get(edge.source ?? ""), hosts.get(edge.target ?? "")]);
}

/** Moves a shape together with its label. */
export function moveShape(shape: DiagramShape, dx: number, dy: number): DiagramShape {
  return {
    ...shape,
    bounds: translate(shape.bounds, dx, dy),
    label: shape.label ? translate(shape.label, dx, dy) : undefined,
  };
}

function offset(axis: Axis, delta: number): readonly [number, number] {
  return axis === "x" ? [delta, 0] : [0, delta];
}

function onMovingSide(point: Point, space: Space): boolean {
  return space.side === "before" ? point[space.axis] <= space.line : point[space.axis] >= space.line;
}

/** The corner of a shape that decides whether it moves: its near side for 'after', its far side for 'before'. */
function decisivePoint(bounds: Rect, space: Space): Point {
  return space.side === "before" ? { x: bounds.x + bounds.width, y: bounds.y + bounds.height } : bounds;
}

/** Shapes that move: on the moving side and not kept; a boundary event follows the decision for its host. */
function movingShapes(plane: DiagramPlane, space: Space, keep: ReadonlySet<string>): Set<string> {
  const byId = shapesById(plane);
  const decide = (shape: DiagramShape): boolean =>
    !keep.has(shape.id) && onMovingSide(decisivePoint(shape.bounds, space), space);
  return new Set(
    plane.shapes
      .filter((shape) => {
        const host = shape.attachedTo ? byId.get(shape.attachedTo) : undefined;
        return !shape.container && decide(host ?? shape);
      })
      .map((shape) => shape.id),
  );
}

function moveEdge(edge: DiagramEdge, space: Space): DiagramEdge {
  const [dx, dy] = offset(space.axis, space.delta);
  const shift = <T extends Point>(point: T): T => (onMovingSide(point, space) ? translate(point, dx, dy) : point);
  return { ...edge, waypoints: edge.waypoints.map(shift), label: edge.label ? shift(edge.label) : undefined };
}

/**
 * A container (pool, lane, expanded sub-process) on the moving side moves; one that reaches across the line grows (or
 * shrinks) by the distance, the way the space tool of the modeler resizes it; others stay.
 */
function spaceContainer(shape: DiagramShape, space: Space): DiagramShape {
  const size = space.axis === "x" ? "width" : "height";
  const start = shape.bounds[space.axis];
  const end = start + shape.bounds[size];
  const [dx, dy] = offset(space.axis, space.delta);
  const before = space.side === "before";
  if (before ? end <= space.line : start >= space.line) {
    return moveShape(shape, dx, dy);
  }
  if (start < space.line && end > space.line) {
    const bounds = before
      ? { ...shape.bounds, [space.axis]: start + space.delta, [size]: shape.bounds[size] - space.delta }
      : { ...shape.bounds, [size]: shape.bounds[size] + space.delta };
    return { ...shape, bounds };
  }
  return shape;
}

/**
 * Moves every shape and waypoint on the moving side of `line` on `axis` by `delta`, except the kept shapes;
 * containers move or resize (spaceContainer). Returns the new plane and the ids of the moved shapes.
 */
export function makeSpace(
  plane: DiagramPlane,
  space: Space,
  keep: ReadonlySet<string> = new Set(),
): { plane: DiagramPlane; moved: Set<string> } {
  const moved = movingShapes(plane, space, keep);
  const [dx, dy] = offset(space.axis, space.delta);
  return {
    plane: {
      ...plane,
      shapes: plane.shapes.map((shape) => {
        if (shape.container) {
          return keep.has(shape.id) ? shape : spaceContainer(shape, space);
        }
        return moved.has(shape.id) ? moveShape(shape, dx, dy) : shape;
      }),
      edges: plane.edges.map((edge) => moveEdge(edge, space)),
    },
    moved,
  };
}
