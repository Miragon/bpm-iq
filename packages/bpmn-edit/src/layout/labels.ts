/**
 * Places external labels at the first free candidate position, sized to the name as bpmn-js will draw it (label-size.ts):
 * the question of a gateway right above or below it, before it only when flows leave it there; the label of a boundary
 * event right beside it; an event label below, above, right or left of it and at its corners; beside the segments of a flow, from where it forks off the trunk it shares with the other
 * branches of its source, right behind the start of a segment, so a branch label stays near its gateway.
 * Free means no foreign shape, flow or label comes closer than LABEL_CLEARANCE; when no candidate is free, the one
 * with the fewest conflicts wins.
 */
import { type DiagramEdge, type DiagramPlane, type DiagramShape, FLOW_EDGE_TYPES } from "../diagram/plane.ts";
import {
  type Point,
  type Rect,
  rectsOverlap,
  type Segment,
  segmentCrossesRect,
  segmentLength,
  segmentsOf,
} from "../geometry/geometry.ts";
import { sharedStart, trimStart } from "../geometry/paths.ts";
import { kindOf, LABEL_CLEARANCE, LABEL_DISTANCE, SHAPE_LABEL_DISTANCE } from "./constants.ts";
import { labelSize } from "./label-size.ts";

/** Lines a shape label takes, and one line more when it does not fit that way. */
const SHAPE_LABEL_LINES = [2, 2 + 1];
/** Lines a flow label takes, and one line more when it does not fit that way. */
const FLOW_LABEL_LINES = [1, 1 + 1];

interface Obstacles {
  readonly shapes: readonly DiagramShape[];
  readonly segments: readonly (readonly [string, Segment])[];
  readonly labels: Map<string, Rect>;
}

/**
 * The question of a gateway hangs right at it: above or below the gateway where no flow leaves it, else before it,
 * left of the gateway above or below the flow coming in.
 */
function gatewayCandidates(shape: DiagramShape, label: Rect): Rect[] {
  const { x, y, width, height } = shape.bounds;
  const centreX = x + width / 2 - label.width / 2;
  const left = x - label.width - SHAPE_LABEL_DISTANCE;
  const line = y + height / 2;
  return [
    { ...label, x: centreX, y: y - label.height - SHAPE_LABEL_DISTANCE },
    { ...label, x: centreX, y: y + height + SHAPE_LABEL_DISTANCE },
    { ...label, x: left, y: line - label.height - SHAPE_LABEL_DISTANCE },
    { ...label, x: left, y: line + SHAPE_LABEL_DISTANCE },
  ];
}

/**
 * A boundary event sits on the border of its host and its flow leaves downwards: its label stands right beside it,
 * below the border, then left of it, then below it beside the flow.
 */
function boundaryCandidates(shape: DiagramShape, label: Rect): Rect[] {
  const { x, y, width, height } = shape.bounds;
  const border = y + height / 2 + LABEL_CLEARANCE;
  const [right, left] = [x + width + SHAPE_LABEL_DISTANCE, x - label.width - SHAPE_LABEL_DISTANCE];
  const [besideRight, besideLeft] = [x + width / 2 + LABEL_CLEARANCE, x + width / 2 - LABEL_CLEARANCE - label.width];
  const below = y + height + SHAPE_LABEL_DISTANCE;
  return [
    { ...label, x: right, y: border },
    { ...label, x: left, y: border },
    { ...label, x: besideRight, y: below },
    { ...label, x: besideLeft, y: below },
  ];
}

function preferred(shape: DiagramShape, label: Rect): Rect[] {
  if (shape.attachedTo) {
    return boundaryCandidates(shape, label);
  }
  return kindOf(shape.type) === "gateway" ? gatewayCandidates(shape, label) : [];
}

/** The places of a shape label: those its kind prefers, then below, above, beside the shape and at its corners. */
function shapeCandidates(shape: DiagramShape, label: Rect): Rect[] {
  const { x, y, width, height } = shape.bounds;
  const centreX = x + width / 2 - label.width / 2;
  const centreY = y + height / 2 - label.height / 2;
  const [below, above] = [y + height + SHAPE_LABEL_DISTANCE, y - label.height - SHAPE_LABEL_DISTANCE];
  const [right, left] = [x + width + SHAPE_LABEL_DISTANCE, x - label.width - SHAPE_LABEL_DISTANCE];
  return [
    ...preferred(shape, label),
    { ...label, x: centreX, y: below },
    { ...label, x: centreX, y: above },
    { ...label, x: right, y: centreY },
    { ...label, x: left, y: centreY },
    { ...label, x: right, y: below },
    { ...label, x: left, y: below },
    { ...label, x: left, y: above },
    { ...label, x: right, y: above },
  ];
}

function middle([start, end]: Segment): Point {
  return { x: (start.x + end.x) / 2, y: (start.y + end.y) / 2 };
}

/** Where along a segment the label starts: right behind the start of the segment, or at its middle. */
function along([start, end]: Segment, label: Rect): readonly Point[] {
  const { x, y } = middle([start, end]);
  const forwardX = end.x >= start.x;
  const forwardY = end.y >= start.y;
  // the start of a segment is often a shape or a bend: keep the clearance to it as well
  const offset = LABEL_DISTANCE + LABEL_CLEARANCE;
  const nearStart = {
    x: forwardX ? start.x + offset : start.x - offset - label.width,
    y: forwardY ? start.y + offset : start.y - offset - label.height,
  };
  return [nearStart, { x: x - label.width / 2, y: y - label.height / 2 }];
}

/**
 * Beside every segment long enough for the label, from the fork on (behind the `trunk` the flow shares with the other
 * branches of its source, so the label names the branch where it leaves; there its horizontal segments first, so the
 * labels of all branches line up behind the fork), right behind the start of the segment before its middle: above or
 * below a horizontal one, right or left of a vertical one.
 */
function edgeCandidates(edge: DiagramEdge, label: Rect, trunk: number): Rect[] {
  const beside = (points: readonly Point[]): Rect[] => {
    const segments = segmentsOf(points);
    // behind a fork the label sits on the branch itself, right behind the turn off the trunk, like its siblings
    const ordered =
      trunk > 0 ? [...segments.filter(isHorizontal), ...segments.filter((s) => !isHorizontal(s))] : segments;
    return [...ordered.flatMap((segment) => besideSegment(segment, label)), ...closeToStart(segments, label)];
  };
  // a branch too short behind its fork for a free place takes one along its whole way
  return [...beside(trimStart(edge.waypoints, trunk)), ...(trunk > 0 ? beside(edge.waypoints) : [])];
}

function isHorizontal([start, end]: Segment): boolean {
  return start.y === end.y;
}

/** Beside the first segment even when it is shorter than the label: a label always has a place at its flow. */
function closeToStart(segments: readonly Segment[], label: Rect): Rect[] {
  const first = segments[0];
  if (!first) {
    return [];
  }
  const [start, end] = first;
  const { x, y } = middle(first);
  return start.y === end.y
    ? [
        { ...label, x: x - label.width / 2, y: y - label.height - LABEL_DISTANCE },
        { ...label, x: x - label.width / 2, y: y + LABEL_DISTANCE },
      ]
    : [
        { ...label, x: x + LABEL_DISTANCE, y: y - label.height / 2 },
        { ...label, x: x - label.width - LABEL_DISTANCE, y: y - label.height / 2 },
      ];
}

/** Beside one segment long enough for the label: right behind its start, then at its middle. */
function besideSegment(segment: Segment, label: Rect): Rect[] {
  const [start, end] = segment;
  const room = segmentLength(segment) - 2 * (LABEL_DISTANCE + LABEL_CLEARANCE);
  if (start.y === end.y && room >= label.width) {
    return along(segment, label).flatMap(({ x }) => [
      { ...label, x, y: start.y - label.height - LABEL_DISTANCE },
      { ...label, x, y: start.y + LABEL_DISTANCE },
    ]);
  }
  if (start.x === end.x && room >= label.height) {
    return along(segment, label).flatMap(({ y }) => [
      { ...label, x: start.x + LABEL_DISTANCE, y },
      { ...label, x: start.x - label.width - LABEL_DISTANCE, y },
    ]);
  }
  return [];
}

/** The label with its clearance: what may not reach into it. */
function padded(rect: Rect): Rect {
  return {
    x: rect.x - LABEL_CLEARANCE,
    y: rect.y - LABEL_CLEARANCE,
    width: rect.width + 2 * LABEL_CLEARANCE,
    height: rect.height + 2 * LABEL_CLEARANCE,
  };
}

function conflicts(owner: string, rect: Rect, obstacles: Obstacles): number {
  const area = padded(rect);
  const shapes = obstacles.shapes.filter((shape) => shape.id !== owner && rectsOverlap(area, shape.bounds)).length;
  const flows = obstacles.segments.filter(([id, segment]) => id !== owner && segmentCrossesRect(segment, area)).length;
  const labels = [...obstacles.labels].filter(([id, other]) => id !== owner && rectsOverlap(area, other)).length;
  return shapes + flows + labels;
}

function best(owner: string, candidates: readonly Rect[], obstacles: Obstacles): Rect | undefined {
  let chosen: { rect: Rect; count: number } | undefined;
  for (const rect of candidates) {
    const count = conflicts(owner, rect, obstacles);
    if (count === 0) {
      return rect;
    }
    chosen = !chosen || count < chosen.count ? { rect, count } : chosen;
  }
  return chosen?.rect;
}

function obstaclesOf(plane: DiagramPlane): Obstacles {
  return {
    shapes: plane.shapes.filter((shape) => !shape.container),
    segments: plane.edges
      .filter((edge) => FLOW_EDGE_TYPES.has(edge.type))
      .flatMap((edge) => segmentsOf(edge.waypoints).map((segment) => [edge.id, segment] as const)),
    labels: new Map(
      [...plane.shapes, ...plane.edges].flatMap((element) =>
        element.label ? [[element.id, element.label] as const] : [],
      ),
    ),
  };
}

/** Length of the longest trunk the flow shares with another flow leaving the same source. */
function trunkOf(plane: DiagramPlane, edge: DiagramEdge): number {
  return Math.max(
    0,
    ...plane.edges
      .filter((other) => other.id !== edge.id && other.source !== undefined && other.source === edge.source)
      .map((other) => sharedStart(edge.waypoints, other.waypoints)),
  );
}

/** New positions for the labels of the given elements; elements without a label keep none. */
export function placeLabels(plane: DiagramPlane, owners: ReadonlySet<string>): DiagramPlane {
  const obstacles = obstaclesOf(plane);
  const place = <T extends DiagramShape | DiagramEdge>(
    element: T,
    candidates: (label: Rect) => Rect[],
    lines: readonly number[],
  ): T => {
    if (!owners.has(element.id) || !element.label) {
      return element;
    }
    const { label, name } = element;
    // the places for the label on its preferred lines first, then on one line more where it does not fit
    const sizes = name ? lines.map((count) => ({ ...label, ...labelSize(name, count) })) : [label];
    const chosen = best(element.id, sizes.flatMap(candidates), obstacles) ?? sizes[0] ?? label;
    obstacles.labels.set(element.id, chosen);
    return { ...element, label: chosen };
  };
  return {
    ...plane,
    shapes: plane.shapes.map((shape) => place(shape, (label) => shapeCandidates(shape, label), SHAPE_LABEL_LINES)),
    // a flow label stays on one line beside its line, on two where its line is too short
    edges: plane.edges.map((edge) =>
      place(edge, (label) => edgeCandidates(edge, label, trunkOf(plane, edge)), FLOW_LABEL_LINES),
    ),
  };
}

/** How far an external label may stand from its shape or flow before it counts as lost. */
const LABEL_REACH = 60;

function distance(first: Rect, second: Rect): number {
  return Math.max(
    0,
    first.x - (second.x + second.width),
    second.x - (first.x + first.width),
    first.y - (second.y + second.height),
    second.y - (first.y + first.height),
  );
}

/** Elements whose external label stands farther than LABEL_REACH from the element: left behind by an old drawing. */
export function distantLabels(plane: DiagramPlane): Set<string> {
  const far = (label: Rect, parts: readonly Rect[]): boolean =>
    parts.length > 0 && Math.min(...parts.map((part) => distance(label, part))) > LABEL_REACH;
  const segmentBox = ([start, end]: Segment): Rect => ({
    x: Math.min(start.x, end.x),
    y: Math.min(start.y, end.y),
    width: Math.abs(start.x - end.x),
    height: Math.abs(start.y - end.y),
  });
  return new Set([
    ...plane.shapes.filter((shape) => shape.label && far(shape.label, [shape.bounds])).map((shape) => shape.id),
    ...plane.edges
      .filter((edge) => edge.label && far(edge.label, segmentsOf(edge.waypoints).map(segmentBox)))
      .map((edge) => edge.id),
  ]);
}
