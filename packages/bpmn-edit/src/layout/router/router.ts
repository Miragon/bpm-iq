/**
 * Orthogonal routing of one flow around the shapes of its plane: every allowed pair of source and target port is
 * searched on the routing grid, the cheapest route (length plus bends) wins.
 */
import type { DiagramEdge, DiagramPlane, DiagramShape } from "../../diagram/plane.ts";
import { FLOW_EDGE_TYPES } from "../../diagram/plane.ts";
import type { Point, Rect, Segment } from "../../geometry/geometry.ts";
import { boundingBox, EPSILON, isBend, segmentCrossesRect, segmentsOf } from "../../geometry/geometry.ts";
import { BEND_PENALTY, ROUTE_MARGIN } from "../constants.ts";
import { endsOf, shapesById } from "../space.ts";
import { branchIds, freePorts, withForks } from "./branches.ts";
import { buildGrid, type Grid } from "./grid.ts";
import { opposite, type Port, targetPorts, VECTORS } from "./ports.ts";
import { search, type SearchResult } from "./search.ts";

/** How far the first search window reaches beyond source and target. */
const WINDOW_REACH = 250;

function inflate(rect: Rect, margin: number): Rect {
  return { x: rect.x - margin, y: rect.y - margin, width: rect.width + 2 * margin, height: rect.height + 2 * margin };
}

function stub(port: Port): Point {
  const vector = VECTORS[port.direction];
  return { x: port.point.x + vector.x * ROUTE_MARGIN, y: port.point.y + vector.y * ROUTE_MARGIN };
}

/**
 * Every shape keeps a margin, source and target included: the route starts and ends on a stub exactly on that margin.
 * The host of a boundary event is left out, the event sits on its border.
 */
function obstaclesFor(plane: DiagramPlane, source: DiagramShape, target: DiagramShape): Rect[] {
  const hosts = new Set([source.attachedTo, target.attachedTo]);
  return plane.shapes
    .filter((shape) => !shape.container && !hosts.has(shape.id))
    .map((shape) => inflate(shape.bounds, ROUTE_MARGIN));
}

function locate(grid: Grid, point: Point): readonly [number, number] | undefined {
  const i = grid.xs.findIndex((x) => Math.abs(x - Math.round(point.x)) < EPSILON);
  const j = grid.ys.findIndex((y) => Math.abs(y - Math.round(point.y)) < EPSILON);
  return i === -1 || j === -1 ? undefined : [i, j];
}

/** Drops points that lie on a straight line between their neighbours. */
function simplify(points: readonly Point[]): Point[] {
  return points.filter((point, index) => {
    const before = points[index - 1];
    const after = points[index + 1];
    return !before || !after || isBend(before, point, after);
  });
}

interface Candidate {
  readonly from: Port;
  readonly to: Port;
  /** the point the route starts at before `from`, when `from` is a fork behind the source */
  readonly lead?: Point;
}

/**
 * Segments of the other flows. Flows into the same target may merge with this one (a shared last stretch), the
 * forward branches of the same source may share its trunk and fork from it, as the metrics allow both; every other
 * flow, a loop return of the same source included, costs extra when crossed or covered.
 */
function otherFlows(plane: DiagramPlane, edge: DiagramEdge): Segment[] {
  const branches = branchIds(plane, edge);
  return plane.edges
    .filter(
      (other) =>
        other.id !== edge.id &&
        FLOW_EDGE_TYPES.has(other.type) &&
        other.target !== edge.target &&
        !branches.has(other.id),
    )
    .flatMap((other) => segmentsOf(other.waypoints));
}

/** The borders of pools, lanes and other containers: a route along one of them is hard to tell from the border. */
function containerBorders(plane: DiagramPlane): Segment[] {
  return plane.shapes
    .filter((shape) => shape.container)
    .flatMap(({ bounds: { x, y, width, height } }): Segment[] => [
      [
        { x, y },
        { x: x + width, y },
      ],
      [
        { x, y: y + height },
        { x: x + width, y: y + height },
      ],
      [
        { x, y },
        { x, y: y + height },
      ],
      [
        { x: x + width, y },
        { x: x + width, y: y + height },
      ],
    ]);
}

interface Surroundings {
  readonly obstacles: readonly Rect[];
  readonly flows: readonly Segment[];
}

/**
 * Ports that face each other on one line with nothing in between connect straight: shapes closer than two stubs
 * (a tight hand layout) leave the grid no room, and the straight line is what the author drew anyway.
 */
function straightConnection(candidates: readonly Candidate[], obstacles: readonly Rect[]): Point[] | undefined {
  for (const { from, to } of candidates) {
    const facing = opposite(from.direction) === to.direction;
    const aligned = Math.abs(from.point.x - to.point.x) < EPSILON || Math.abs(from.point.y - to.point.y) < EPSILON;
    const ahead =
      (to.point.x - from.point.x) * VECTORS[from.direction].x +
        (to.point.y - from.point.y) * VECTORS[from.direction].y >
      0;
    const segment = [from.point, to.point] as const;
    const blocked = obstacles.some((rect) => segmentCrossesRect(segment, rect));
    if (facing && aligned && ahead && !blocked) {
      return [from.point, to.point];
    }
  }
  return undefined;
}

/** The route of one candidate on the grid with its cost; the turn at a fork is a bend the search does not see. */
function searchCandidate(grid: Grid, candidate: Candidate): SearchResult | undefined {
  const start = locate(grid, stub(candidate.from));
  const goal = locate(grid, stub(candidate.to));
  const found =
    start && goal
      ? search(
          grid,
          { node: start, direction: candidate.from.direction },
          { node: goal, direction: opposite(candidate.to.direction) },
        )
      : undefined;
  return found && { ...found, cost: found.cost + (candidate.lead ? BEND_PENALTY : 0) };
}

function routeIn(window: Rect, surroundings: Surroundings, candidates: readonly Candidate[]): Point[] | undefined {
  const points = candidates.flatMap(({ from, to }) => [from.point, stub(from), to.point, stub(to)]);
  const grid = buildGrid(surroundings.obstacles, points, window, surroundings.flows);
  let best: (SearchResult & Candidate) | undefined;
  for (const candidate of candidates) {
    const found = searchCandidate(grid, candidate);
    if (found && (!best || found.cost < best.cost)) {
      best = { ...candidate, ...found };
    }
  }
  return best
    ? simplify([...(best.lead ? [best.lead] : []), best.from.point, ...best.points, best.to.point])
    : undefined;
}

/**
 * The plain orthogonal connection from the right side of the source to the left side of the target with a jog in
 * the middle: the last resort when no route exists, attached to both ends even if it passes a shape.
 */
export function directConnection(source: Rect, target: Rect): Point[] {
  const start = { x: source.x + source.width, y: Math.round(source.y + source.height / 2) };
  const end = { x: target.x, y: Math.round(target.y + target.height / 2) };
  const middle = Math.round((start.x + end.x) / 2);
  return start.y === end.y ? [start, end] : [start, { x: middle, y: start.y }, { x: middle, y: end.y }, end];
}

/** The orthogonal route of the flow, or undefined when source or target has no shape or no route exists. */
export function routeEdge(plane: DiagramPlane, edge: DiagramEdge): Point[] | undefined {
  const byId = shapesById(plane);
  const source = edge.source ? byId.get(edge.source) : undefined;
  const target = edge.target ? byId.get(edge.target) : undefined;
  if (!source || !target) {
    return undefined;
  }
  const surroundings = {
    obstacles: obstaclesFor(plane, source, target),
    flows: [...otherFlows(plane, edge), ...containerBorders(plane)],
  };
  const candidates = freePorts(plane, source, edge).flatMap((from) => targetPorts(target).map((to) => ({ from, to })));
  const ends = endsOf(plane, edge);
  const others = plane.shapes.filter((shape) => !shape.container && !ends.has(shape.id));
  const straight = straightConnection(
    candidates,
    others.map((shape) => shape.bounds),
  );
  if (straight) {
    return straight;
  }
  const near = boundingBox([source.bounds, target.bounds], []);
  const whole = boundingBox(
    plane.shapes.map((shape) => shape.bounds),
    [],
  );
  const windows = [near, whole].flatMap((box) => (box ? [inflate(box, WINDOW_REACH)] : []));
  // a branch of a gateway into another row forks right behind it; only when it cannot, it runs on first
  const forking = withForks(plane, edge, candidates);
  const choices = forking.some((candidate) => candidate.lead) ? [forking, candidates] : [candidates];
  for (const choice of choices) {
    for (const window of windows) {
      const route = routeIn(window, surroundings, choice);
      if (route) {
        return route;
      }
    }
  }
  return undefined;
}
