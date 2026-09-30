/**
 * Flows of a shape that moved a little keep their route: the end point moves with the shape and the neighbouring
 * segment stretches, the way the modeler reconnects a flow while a shape is dragged. A straight flow whose end
 * moves across it gets a jog in the middle. Only a flow that is no longer orthogonal or now runs through a foreign
 * shape needs a new route.
 */
import { type DiagramEdge, type DiagramPlane, FLOW_EDGE_TYPES } from "../diagram/plane.ts";
import { EPSILON, type Point, segmentCrossesRect, segmentsOf } from "../geometry/geometry.ts";
import { MIN_STUB } from "./constants.ts";
import { endsOf, shapesById, translate } from "./space.ts";

type Delta = readonly [number, number];

function horizontal(first: Point, second: Point): boolean {
  return Math.abs(first.y - second.y) < EPSILON;
}

function vertical(first: Point, second: Point): boolean {
  return Math.abs(first.x - second.x) < EPSILON;
}

/** Moves the first point by the delta and keeps the first segment orthogonal. */
function moveStart(points: readonly Point[], [dx, dy]: Delta): Point[] {
  const [first, second, ...rest] = points;
  if (!first || !second) {
    return [...points];
  }
  const moved = translate(first, dx, dy);
  if (rest.length === 0) {
    return straight(moved, second, first);
  }
  const bent = horizontal(first, second) ? { x: second.x, y: second.y + dy } : { x: second.x + dx, y: second.y };
  return [moved, bent, ...rest];
}

/**
 * A two-point flow after its start moved: straight when it still lines up, with a jog in the middle otherwise. The
 * jog needs room for a straight stub at both ends; without it the flow stays diagonal and is routed anew.
 */
function straight(start: Point, end: Point, original: Point): Point[] {
  if (horizontal(original, end) && !horizontal(start, end) && Math.abs(end.x - start.x) >= 2 * MIN_STUB) {
    const middle = (start.x + end.x) / 2;
    return [start, { x: middle, y: start.y }, { x: middle, y: end.y }, end];
  }
  if (vertical(original, end) && !vertical(start, end) && Math.abs(end.y - start.y) >= 2 * MIN_STUB) {
    const middle = (start.y + end.y) / 2;
    return [start, { x: start.x, y: middle }, { x: end.x, y: middle }, end];
  }
  return [start, end];
}

function stretched(edge: DiagramEdge, source: Delta | undefined, target: Delta | undefined): Point[] {
  if (source && target && source[0] === target[0] && source[1] === target[1]) {
    return edge.waypoints.map((point) => translate(point, source[0], source[1]));
  }
  const fromStart = source ? moveStart(edge.waypoints, source) : [...edge.waypoints];
  return target ? moveStart(fromStart.reverse(), target).reverse() : fromStart;
}

/** The first and the last segment are the stubs at the shapes; each needs MIN_STUB unless the flow is straight. */
function stubsLongEnough(segments: ReturnType<typeof segmentsOf>): boolean {
  const [first] = segments;
  const last = segments.at(-1);
  const length = (segment: typeof first): number =>
    segment ? Math.abs(segment[1].x - segment[0].x) + Math.abs(segment[1].y - segment[0].y) : 0;
  return segments.length < 2 || (length(first) >= MIN_STUB - EPSILON && length(last) >= MIN_STUB - EPSILON);
}

function valid(points: readonly Point[], edge: DiagramEdge, plane: DiagramPlane): boolean {
  const segments = segmentsOf(points);
  if (!stubsLongEnough(segments)) {
    return false;
  }
  const ends = endsOf(plane, edge);
  const orthogonal = segments.every(([start, end]) => horizontal(start, end) || vertical(start, end));
  const blocked = plane.shapes.some(
    (shape) =>
      !shape.container && !ends.has(shape.id) && segments.some((segment) => segmentCrossesRect(segment, shape.bounds)),
  );
  return orthogonal && !blocked;
}

/** How far every moved shape moved between the two versions of the plane. */
function deltas(before: DiagramPlane, after: DiagramPlane, moved: ReadonlySet<string>): Map<string, Delta> {
  const old = shapesById(before);
  return new Map(
    after.shapes.flatMap((shape) => {
      const previous = old.get(shape.id)?.bounds;
      return moved.has(shape.id) && previous
        ? [[shape.id, [shape.bounds.x - previous.x, shape.bounds.y - previous.y] as const]]
        : [];
    }),
  );
}

/** Stretches the flows of the moved shapes; returns the plane and the flows that still need a route. */
export function stretchFlows(
  before: DiagramPlane,
  after: DiagramPlane,
  moved: ReadonlySet<string>,
): { plane: DiagramPlane; unresolved: Set<string> } {
  const byShape = deltas(before, after, moved);
  const unresolved = new Set<string>();
  const edges = after.edges.map((edge) => {
    const source = byShape.get(edge.source ?? "");
    const target = byShape.get(edge.target ?? "");
    if (!FLOW_EDGE_TYPES.has(edge.type) || (!source && !target)) {
      return edge;
    }
    const waypoints = stretched(edge, source, target);
    if (!valid(waypoints, edge, after)) {
      unresolved.add(edge.id);
      return edge;
    }
    return { ...edge, waypoints };
  });
  return { plane: { ...after, edges }, unresolved };
}
