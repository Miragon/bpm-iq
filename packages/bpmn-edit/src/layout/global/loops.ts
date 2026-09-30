/**
 * Loop returns in the global layout, drawn the way loops are drawn in BPMN: every sequence flow that runs back to a
 * node left of its source leaves a gateway or an event downwards (an activity to the right), runs down into a channel
 * below everything in the columns of its loop, back to the left, and up into its target: into an activity from the left, into a gateway or an event
 * from below. The channel lies below the content of the innermost frame of the source (its sub-process, lane or
 * pool), so it stays in that frame. Nested loops get stacked channels, the inner loop nearest to the content, so they never cross.
 */
import { type DiagramEdge, type DiagramPlane, type DiagramShape, frameOf } from "../../diagram/plane.ts";
import type { Point, Rect } from "../../geometry/geometry.ts";
import { kindOf, MIN_STUB } from "../constants.ts";
import { center } from "../space.ts";

/** Distance of the first channel below the content, and between two stacked channels. */
const CHANNEL_GAP = 30;

interface Loop {
  readonly edge: DiagramEdge;
  /** whether the loop leaves its source downwards (not an activity), else to the right */
  readonly downwards: boolean;
  /** the frame the channel stays in: the innermost frame of the source */
  readonly frame: string;
  readonly source: Rect;
  readonly target: Rect;
  readonly targetKind: string;
}

/** The loop a sequence flow closes, when it runs back to a node left of its source. */
function loopOf(edge: DiagramEdge, byId: ReadonlyMap<string, DiagramShape>): Loop | undefined {
  const [source, target] = [byId.get(edge.source ?? ""), byId.get(edge.target ?? "")];
  if (edge.type !== "SequenceFlow" || !source || !target) {
    return undefined;
  }
  if (center(target.bounds).x >= center(source.bounds).x) {
    return undefined;
  }
  const host = source.attachedTo ? byId.get(source.attachedTo) : undefined;
  return {
    edge,
    // an activity is left to the right; a gateway, an event and a boundary event are left downwards
    downwards: kindOf(source.type) !== "activity",
    frame: frameOf(host ?? source),
    source: source.bounds,
    target: target.bounds,
    targetKind: kindOf(target.type),
  };
}

function loopsOf(plane: DiagramPlane): Loop[] {
  const byId = new Map(plane.shapes.map((shape) => [shape.id, shape]));
  return plane.edges.flatMap((edge) => loopOf(edge, byId) ?? []);
}

/** The lowest point of the shapes (labels included) and flows of the loop's frame between two x positions. */
function floorBetween(
  plane: DiagramPlane,
  loop: Loop,
  [left, right]: readonly [number, number],
  skip: ReadonlySet<string>,
): number {
  const inFrame = new Set(plane.shapes.filter((shape) => frameOf(shape) === loop.frame).map((shape) => shape.id));
  const inRange = (from: number, to: number): boolean => from <= right && to >= left;
  const shapes = plane.shapes
    .filter(
      (shape) =>
        inFrame.has(shape.id) && !shape.container && inRange(shape.bounds.x, shape.bounds.x + shape.bounds.width),
    )
    .flatMap((shape) => [shape.bounds, ...(shape.label ? [shape.label] : [])])
    .map((rect) => rect.y + rect.height);
  const bottom = frameBottom(plane, loop);
  const flows = plane.edges
    .filter((edge) => !skip.has(edge.id) && (inFrame.has(edge.source ?? "") || inFrame.has(edge.target ?? "")))
    .flatMap((edge) => edge.waypoints.filter((point) => point.x >= left && point.x <= right && point.y < bottom))
    .map((point) => point.y);
  return Math.max(loop.source.y + loop.source.height, ...shapes, ...flows);
}

/** The bottom border of the loop's frame, none on a plane without frames. */
function frameBottom(plane: DiagramPlane, loop: Loop): number {
  const frame = plane.shapes.find((shape) => shape.id === loop.frame)?.bounds;
  return frame ? frame.y + frame.height : Infinity;
}

/** The way into the target from the channel: into an activity from the left, into a gateway or an event from below. */
function entry(loop: Loop, channel: number): Point[] {
  const { target } = loop;
  if (loop.targetKind === "activity") {
    const into = target.x - MIN_STUB;
    const row = Math.round(target.y + target.height / 2);
    return [
      { x: into, y: channel },
      { x: into, y: row },
      { x: target.x, y: row },
    ];
  }
  const middle = Math.round(target.x + target.width / 2);
  return [
    { x: middle, y: channel },
    { x: middle, y: target.y + target.height },
  ];
}

/**
 * The way from the source down into the channel: straight down from a gateway or an event, so the forward flows keep
 * the right side and fan out from there without crossing the loop; out to the right from an activity.
 */
function exit(loop: Loop, channel: number): Point[] {
  const { source } = loop;
  if (loop.downwards) {
    const middle = Math.round(source.x + source.width / 2);
    return [
      { x: middle, y: source.y + source.height },
      { x: middle, y: channel },
    ];
  }
  const start = { x: source.x + source.width, y: Math.round(source.y + source.height / 2) };
  const out = start.x + MIN_STUB;
  return [start, { x: out, y: start.y }, { x: out, y: channel }];
}

function waypoints(loop: Loop, channel: number): Point[] {
  return [...exit(loop, channel), ...entry(loop, channel)];
}

/** Routes every loop return through its channel; the ids of the loop returns are `loopIds(plane)`. */
export function routeLoops(plane: DiagramPlane): DiagramPlane {
  const loops = loopsOf(plane).sort(
    (first, second) => first.source.x - first.target.x - (second.source.x - second.target.x),
  );
  const skip = new Set(loops.map((loop) => loop.edge.id));
  const routes = new Map<string, Point[]>();
  const channels: { readonly left: number; readonly right: number; readonly y: number }[] = [];
  for (const loop of loops) {
    const [left, right] = [loop.target.x - 2 * MIN_STUB, loop.source.x + loop.source.width + 2 * MIN_STUB];
    const below = channels
      .filter((channel) => channel.left <= right && channel.right >= left)
      .map((channel) => channel.y);
    // inside the frame: at most half a channel gap above its bottom border
    const y = Math.min(
      Math.max(floorBetween(plane, loop, [left, right], skip), ...below) + CHANNEL_GAP,
      frameBottom(plane, loop) - CHANNEL_GAP / 2,
    );
    channels.push({ left, right, y });
    routes.set(loop.edge.id, waypoints(loop, y));
  }
  return {
    ...plane,
    edges: plane.edges.map((edge) => ({ ...edge, waypoints: routes.get(edge.id) ?? edge.waypoints })),
  };
}

/** The sequence flows that run back to a node left of their source. */
export function loopIds(plane: DiagramPlane): Set<string> {
  return new Set(loopsOf(plane).map((loop) => loop.edge.id));
}
