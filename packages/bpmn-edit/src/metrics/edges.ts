/** Edge metrics on the flow connections of one plane: crossings, overlaps, detours through shapes, bends, length. */
import { type DiagramEdge, type DiagramPlane, type DiagramShape, FLOW_EDGE_TYPES } from "../diagram/plane.ts";
import {
  boxesMeet,
  boxOf,
  collinearOverlap,
  EPSILON,
  isBend,
  type Rect,
  type Segment,
  segmentCrossesRect,
  segmentLength,
  segmentsCross,
  segmentsOf,
} from "../geometry/geometry.ts";
import { sharedStart, trimStart } from "../geometry/paths.ts";
import { obstacles } from "./shapes.ts";

/** Shorter common stretches of two edges are docking artefacts, not a visible overlap. */
const MIN_OVERLAP_LENGTH = 2;
/**
 * Shortest straight piece at the start and end of a flow (flow-connection-side).
 */
export const MIN_STUB = 20;

export interface FlowPath {
  readonly edge: DiagramEdge;
  readonly segments: readonly Segment[];
  /** bounding box of the waypoints */
  readonly box: Rect;
  readonly ends: ReadonlySet<string>;
}

export function flowPaths(plane: DiagramPlane): FlowPath[] {
  return plane.edges
    .filter((edge) => FLOW_EDGE_TYPES.has(edge.type) && edge.waypoints.length > 1)
    .map((edge) => ({
      edge,
      segments: segmentsOf(edge.waypoints),
      box: boxOf(edge.waypoints),
      ends: new Set([edge.source, edge.target].filter((id): id is string => id !== undefined)),
    }));
}

function sharesEnd(first: FlowPath, second: FlowPath): boolean {
  return [...first.ends].some((id) => second.ends.has(id));
}

function cross(first: FlowPath, second: FlowPath): boolean {
  return first.segments.some((a) => second.segments.some((b) => segmentsCross(a, b)));
}

/** The segments of both flows behind the trunk they share from a common source, where a split forks. */
function behindFork(first: FlowPath, second: FlowPath): readonly [readonly Segment[], readonly Segment[]] {
  if (first.edge.source === undefined || first.edge.source !== second.edge.source) {
    return [first.segments, second.segments];
  }
  const trunk = sharedStart(first.edge.waypoints, second.edge.waypoints);
  return [segmentsOf(trimStart(first.edge.waypoints, trunk)), segmentsOf(trimStart(second.edge.waypoints, trunk))];
}

function overlap(first: FlowPath, second: FlowPath): boolean {
  const [own, other] = behindFork(first, second);
  return own.some((a) => other.some((b) => collinearOverlap(a, b) > MIN_OVERLAP_LENGTH));
}

function countPairs(paths: readonly FlowPath[], matches: (first: FlowPath, second: FlowPath) => boolean): number {
  let count = 0;
  paths.forEach((first, index) => {
    count += paths.slice(index + 1).filter((second) => matches(first, second)).length;
  });
  return count;
}

/** Pairs of flows that properly cross; flows meeting at a common element are a join or split, not a crossing. */
export function countCrossings(paths: readonly FlowPath[]): number {
  return countPairs(paths, (first, second) => !sharesEnd(first, second) && cross(first, second));
}

/**
 * Pairs of flows that run on top of each other for a visible stretch. Flows into the same element may share their
 * last stretch on purpose (error paths merging into one result end event); the branches of a split may share the trunk
 * they leave their source on and fork from; behind the fork an overlap hides where each branch goes and counts.
 */
export function countOverlaps(paths: readonly FlowPath[]): number {
  return countPairs(paths, (first, second) => first.edge.target !== second.edge.target && overlap(first, second));
}

/** Ids of the flows that properly cross another flow, by the rule of countCrossings. */
export function crossingFlows(plane: DiagramPlane): Set<string> {
  const paths = flowPaths(plane);
  return new Set(
    paths
      .filter((first) => paths.some((second) => second !== first && !sharesEnd(first, second) && cross(first, second)))
      .map((path) => path.edge.id),
  );
}

/** Ids of the flows that run on top of another flow, by the rule of countOverlaps. */
export function overlappingFlows(plane: DiagramPlane): Set<string> {
  const paths = flowPaths(plane);
  return new Set(
    paths
      .filter((first) =>
        paths.some((second) => second !== first && first.edge.target !== second.edge.target && overlap(first, second)),
      )
      .map((path) => path.edge.id),
  );
}

/** Elements a flow may touch: its source and target, and the hosts when one of them is a boundary event. */
function allowedShapes(path: FlowPath, byId: ReadonlyMap<string, DiagramShape>): Set<string> {
  const allowed = new Set(path.ends);
  for (const id of path.ends) {
    const host = byId.get(id)?.attachedTo;
    if (host) {
      allowed.add(host);
    }
  }
  return allowed;
}

/** Pairs of flow and foreign shape where the flow runs through the shape. */
export function countThroughShape(paths: readonly FlowPath[], shapes: readonly DiagramShape[]): number {
  const blocking = obstacles(shapes);
  const byId = new Map(blocking.map((shape) => [shape.id, shape]));
  let count = 0;
  for (const path of paths) {
    const allowed = allowedShapes(path, byId);
    count += blocking.filter(
      (shape) =>
        !allowed.has(shape.id) &&
        boxesMeet(path.box, shape.bounds) &&
        path.segments.some((segment) => segmentCrossesRect(segment, shape.bounds)),
    ).length;
  }
  return count;
}

export function countBends(paths: readonly FlowPath[]): number {
  let bends = 0;
  for (const { edge } of paths) {
    const points = edge.waypoints;
    for (let index = 1; index < points.length - 1; index++) {
      const [before, corner, after] = [points[index - 1], points[index], points[index + 1]];
      if (before && corner && after && isBend(before, corner, after)) {
        bends++;
      }
    }
  }
  return bends;
}

export function totalLength(paths: readonly FlowPath[]): number {
  return paths.reduce((sum, path) => sum + path.segments.reduce((length, s) => length + segmentLength(s), 0), 0);
}

/** Sequence flows that end left of where they start: loops and flows against the reading direction. */
/** Whether a flow runs back: it ends left of where it starts (a loop return, or a flow against the reading direction). */
export function runsBack(edge: DiagramEdge): boolean {
  const [first, last] = [edge.waypoints[0], edge.waypoints.at(-1)];
  return first !== undefined && last !== undefined && last.x < first.x - EPSILON;
}

export function countBackward(paths: readonly FlowPath[]): number {
  return paths.filter(({ edge }) => edge.type === "SequenceFlow" && runsBack(edge)).length;
}
