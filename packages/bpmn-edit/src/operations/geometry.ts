/**
 * Geometry of an edit: created shapes get their place next to their anchor (in its row, the row below or a new row
 * at the bottom), everything right of the anchor makes room like the space tool of the modeler, remaining collisions
 * give way with minimal displacement; then the touched flows are routed and the labels placed.
 */
import { type DiagramPlane, type DiagramShape, frameOf } from "../diagram/plane.ts";
import { rectsOverlap } from "../geometry/geometry.ts";
import { MIN_SHAPE_GAP } from "../layout/constants.ts";
import { spacingOf } from "../layout/relayout/spacing.ts";
import { affectedEdges, relabel, repairBroken, reroute } from "../layout/reroute.ts";
import { diffPlane, type LayoutResult } from "../layout/result.ts";
import { directConnection } from "../layout/router/router.ts";
import { center, makeSpace, moveShape, shapesById } from "../layout/space.ts";
import { stretchFlows } from "../layout/stretch.ts";
import { separate } from "../layout/tidy.ts";
import type { Effects, Gap, Placement, Relocation } from "./effects.ts";

export interface Arranged {
  readonly result: LayoutResult;
  readonly moved: ReadonlySet<string>;
  readonly planes: ReadonlySet<string>;
}

/** Moves the shape (with its label and its boundary events) so that its top left corner is at (x, y). */
function withBounds(plane: DiagramPlane, id: string, x: number, y: number): DiagramPlane {
  const shape = plane.shapes.find((candidate) => candidate.id === id);
  const [dx, dy] = shape ? [x - shape.bounds.x, y - shape.bounds.y] : [0, 0];
  return {
    ...plane,
    shapes: plane.shapes.map((candidate) =>
      candidate.id === id || candidate.attachedTo === id ? moveShape(candidate, dx, dy) : candidate,
    ),
  };
}

/** the lowest bottom edge of the flow nodes in the frame (lane, pool or sub-process) — of the whole plane without one */
function lowestBottom(plane: DiagramPlane, frame: string, except: string): number {
  const inFrame = plane.shapes.filter(
    (shape) => !shape.container && shape.id !== except && (frame === "" || frameOf(shape) === frame),
  );
  return Math.max(...inFrame.map((shape) => shape.bounds.y + shape.bounds.height));
}

/**
 * The shape at (x, y), moved down past every flow node of its frame it would cover: separation cannot part two shapes
 * drawn on top of each other (it finds no direction), so a node never starts on an occupied spot.
 */
function onFreeSpot(plane: DiagramPlane, id: string, x: number, y: number): DiagramPlane {
  const node = plane.shapes.find((shape) => shape.id === id);
  if (!node) return plane;
  let top = y;
  for (let attempt = 0; attempt < plane.shapes.length; attempt++) {
    const bounds = { ...node.bounds, x, y: top };
    const blocker = plane.shapes.find(
      (shape) => shape.id !== id && !shape.container && shape.attachedTo !== id && rectsOverlap(shape.bounds, bounds),
    );
    if (!blocker) break;
    top = blocker.bounds.y + blocker.bounds.height + MIN_SHAPE_GAP;
  }
  return withBounds(plane, id, x, top);
}

type Arrangement = { plane: DiagramPlane; moved: Set<string> };

/**
 * The shapes separation may not move for a placed node: every flow node but the node and those within the minimum gap
 * of it (the anchor stays too). An edit clears the room it needs and never tidies distant spots of the drawing.
 */
function pinnedAround(plane: DiagramPlane, id: string, anchor: string | undefined): Set<string> {
  const node = plane.shapes.find((shape) => shape.id === id);
  const near = node && {
    x: node.bounds.x - MIN_SHAPE_GAP,
    y: node.bounds.y - MIN_SHAPE_GAP,
    width: node.bounds.width + 2 * MIN_SHAPE_GAP,
    height: node.bounds.height + 2 * MIN_SHAPE_GAP,
  };
  const movable = (shape: DiagramShape): boolean =>
    shape.id === id || (near !== undefined && shape.id !== anchor && rectsOverlap(shape.bounds, near));
  return new Set(plane.shapes.filter((shape) => !shape.container && !movable(shape)).map((shape) => shape.id));
}

/**
 * Clears the room of one placed node: only it and its immediate neighbours move, the frames grow where needed, and
 * the flows of what moved stretch along. The solver treats pinned shapes as heavy, not fixed — it would still part
 * two that stood too close before the edit — so pinned shapes (and their boundary events) are put back; its full
 * solution is kept only when the node would then overlap one of them.
 */
function settle(plane: DiagramPlane, id: string, anchor: string | undefined, before: ReadonlySet<string>): Arrangement {
  const pins = pinnedAround(plane, id, anchor);
  const separated = separate(plane, pins);
  const original = shapesById(plane);
  const stays = (shape: DiagramShape): boolean =>
    pins.has(shape.id) || (shape.attachedTo !== undefined && pins.has(shape.attachedTo));
  const restored: DiagramPlane = {
    ...separated.plane,
    shapes: separated.plane.shapes.map((shape) => (stays(shape) ? (original.get(shape.id) ?? shape) : shape)),
  };
  const clash = restored.shapes.some(
    (free) =>
      !free.container &&
      !stays(free) &&
      restored.shapes.some(
        (other) => stays(other) && !other.container && !other.attachedTo && rectsOverlap(free.bounds, other.bounds),
      ),
  );
  const solution = clash ? separated : { plane: restored, moved: [...separated.moved].filter((m) => !pins.has(m)) };
  return {
    plane: stretchFlows(plane, solution.plane, new Set(solution.moved)).plane,
    moved: new Set([...before, ...solution.moved]),
  };
}

/**
 * Inserted into the sequence: like a human with the space tool, the rest of the sequence moves on by one column, so
 * the diagram keeps reading left to right. The line runs right of the anchor — or, when the node it now precedes is
 * not a full column right of the anchor (drawn below it, say), at that node, whose place it takes. The node goes into
 * the row the split flow leads into: a flow that leaves the anchor downwards is a branch, and what is inserted into it
 * belongs to that branch.
 */
function placeInSequence(
  plane: DiagramPlane,
  node: DiagramShape,
  anchor: DiagramShape,
  placement: Placement,
): Arrangement {
  const byId = shapesById(plane);
  const { columnGap } = spacingOf(plane);
  const right = anchor.bounds.x + anchor.bounds.width;
  const target = placement.before ? byId.get(placement.before) : undefined;
  const band = node.lane && node.lane !== anchor.lane ? byId.get(node.lane) : undefined;
  const cramped = target !== undefined && target.bounds.x < right + columnGap;
  const line = cramped ? target.bounds.x - 1 : right + 1;
  const x = cramped ? target.bounds.x : right + columnGap;
  const keep = new Set([
    node.id,
    anchor.id,
    ...plane.shapes.filter((shape) => shape.attachedTo === anchor.id).map((shape) => shape.id),
  ]);
  const spaced = makeSpace(plane, { axis: "x", line, delta: node.bounds.width + columnGap }, keep);
  const row = center((target ?? band ?? anchor).bounds).y;
  const y = row - node.bounds.height / 2;
  const straight = !band && !cramped && row === center(anchor.bounds).y;
  if (straight) {
    // the free column the space tool opened in the anchor's own row: nothing else to clear
    return { plane: withBounds(spaced.plane, node.id, x, y), moved: spaced.moved };
  }
  return settle(onFreeSpot(spaced.plane, node.id, x, y), node.id, anchor.id, spaced.moved);
}

/**
 * A new branch in the next column: in the band of its lane when that is another role's, else in the row below the
 * anchor or below everything in its frame (lane, pool or sub-process). Nothing of the sequence moves.
 */
function placeBranch(
  plane: DiagramPlane,
  node: DiagramShape,
  anchor: DiagramShape,
  row: Placement["row"],
): Arrangement {
  const byId = shapesById(plane);
  const { columnGap, rowSpacing } = spacingOf(plane);
  const x = anchor.bounds.x + anchor.bounds.width + columnGap;
  const band = node.lane && node.lane !== anchor.lane ? byId.get(node.lane) : undefined;
  if (band && row === "below") {
    const placed = onFreeSpot(plane, node.id, x, center(band.bounds).y - node.bounds.height / 2);
    return settle(placed, node.id, anchor.id, new Set());
  }
  const frame = frameOf(node);
  const lowest = lowestBottom(plane, frame, node.id);
  const y =
    row === "below"
      ? center(anchor.bounds).y + rowSpacing - node.bounds.height / 2
      : Number.isFinite(lowest)
        ? lowest + Math.max(MIN_SHAPE_GAP, rowSpacing - node.bounds.height)
        : center(byId.get(frame)?.bounds ?? anchor.bounds).y - node.bounds.height / 2;
  return settle(withBounds(plane, node.id, x, y), node.id, anchor.id, new Set());
}

/** Places one created shape and returns the plane and the shapes that moved to make room. */
function place(plane: DiagramPlane, placement: Placement): Arrangement {
  const byId = shapesById(plane);
  const anchor = byId.get(placement.anchor);
  const node = byId.get(placement.id);
  if (!anchor || !node) {
    return { plane, moved: new Set() };
  }
  return placement.row === "same"
    ? placeInSequence(plane, node, anchor, placement)
    : placeBranch(plane, node, anchor, placement.row);
}

/**
 * Moves a node that changed its lane into the band of the lane, in its column; separation then clears collisions
 * and keeps it inside the lane (its frame, read from the semantic model).
 */
function relocate(plane: DiagramPlane, relocation: Relocation): Arrangement {
  const byId = shapesById(plane);
  const node = byId.get(relocation.id);
  const lane = byId.get(relocation.lane);
  if (!node || !lane) {
    return { plane, moved: new Set() };
  }
  const placed = onFreeSpot(plane, node.id, node.bounds.x, center(lane.bounds).y - node.bounds.height / 2);
  return settle(placed, node.id, undefined, new Set([node.id]));
}

/** Shifts everything right of a removed shape back when no other shape occupies its column. */
function closeGap(plane: DiagramPlane, gap: Gap): { plane: DiagramPlane; moved: Set<string> } {
  const { columnGap } = spacingOf(plane);
  const occupied = plane.shapes.some(
    (shape) =>
      !shape.container && shape.bounds.x < gap.right + columnGap && shape.bounds.x + shape.bounds.width > gap.left,
  );
  if (occupied) {
    return { plane, moved: new Set() };
  }
  return makeSpace(plane, { axis: "x", line: gap.right + 1, delta: -(gap.right - gap.left + columnGap) });
}

/**
 * Flows to route start from a plain orthogonal connection between the final shapes (right side out, left side in,
 * a jog in the middle), so a flow the router cannot place is still attached to both ends.
 */
function provisionalRoutes(plane: DiagramPlane, routes: ReadonlySet<string>): DiagramPlane {
  const byId = shapesById(plane);
  return {
    ...plane,
    edges: plane.edges.map((edge) => {
      const source = byId.get(edge.source ?? "")?.bounds;
      const target = byId.get(edge.target ?? "")?.bounds;
      return routes.has(edge.id) && source && target ? { ...edge, waypoints: directConnection(source, target) } : edge;
    }),
  };
}

function hasShape(plane: DiagramPlane, id: string): boolean {
  return plane.shapes.some((shape: DiagramShape) => shape.id === id);
}

/**
 * Puts every created shape whose provisional place lies outside its lane into that lane's band first: a batch creates
 * all its nodes before any is placed, and the separation of the first placement must not meet a later node drawn in a
 * foreign band (it would stretch the lanes around it).
 */
function intoTheirBands(plane: DiagramPlane, created: readonly string[]): DiagramPlane {
  let current = plane;
  for (const id of created) {
    const byId = shapesById(current);
    const node = byId.get(id);
    const lane = node?.lane ? byId.get(node.lane) : undefined;
    if (!node || !lane) continue;
    const middle = center(node.bounds).y;
    if (middle < lane.bounds.y || middle > lane.bounds.y + lane.bounds.height) {
      current = withBounds(current, id, node.bounds.x, center(lane.bounds).y - node.bounds.height / 2);
    }
  }
  return current;
}

function arrangePlane(plane: DiagramPlane, effects: Effects): { plane: DiagramPlane; moved: Set<string> } {
  let current = intoTheirBands(
    plane,
    effects.placements.map((placement) => placement.id),
  );
  const moved = new Set<string>();
  for (const placement of effects.placements.filter((candidate) => hasShape(plane, candidate.id))) {
    const placed = place(current, placement);
    current = placed.plane;
    placed.moved.forEach((id) => moved.add(id));
  }
  for (const relocation of effects.relocations.filter((candidate) => hasShape(plane, candidate.id))) {
    const relocated = relocate(current, relocation);
    current = relocated.plane;
    relocated.moved.forEach((id) => moved.add(id));
  }
  for (const gap of effects.gaps.filter((candidate) => candidate.plane === plane.id)) {
    const closed = closeGap(current, gap);
    current = closed.plane;
    closed.moved.forEach((id) => moved.add(id));
  }
  const created = new Set([
    ...effects.placements.map((placement) => placement.id),
    ...effects.relocations.map((relocation) => relocation.id),
  ]);
  // shapes the space tool shifted keep valid flows; routes are needed for created, reconnected and blocked flows
  const routes = new Set([...effects.routes, ...affectedEdges(current, created)]);
  current = provisionalRoutes(current, routes);
  const routed = repairBroken(plane, reroute(current, routes));
  return { plane: relabel(routed, new Set([...routes, ...created, ...effects.labels])), moved };
}

function touches(plane: DiagramPlane, effects: Effects): boolean {
  const ids = [
    ...effects.placements.map((placement) => placement.id),
    ...effects.relocations.map((relocation) => relocation.id),
    ...effects.routes,
    ...effects.labels,
  ];
  return (
    effects.gaps.some((gap) => gap.plane === plane.id) ||
    ids.some((id) => hasShape(plane, id) || plane.edges.some((edge) => edge.id === id))
  );
}

export function arrange(planes: readonly DiagramPlane[], effects: Effects): Arranged {
  const changes = planes
    .filter((plane) => touches(plane, effects))
    .map((plane) => ({ before: plane, ...arrangePlane(plane, effects) }));
  const diffs = changes.map((change) => diffPlane(change.before, change.plane));
  return {
    result: {
      shapes: diffs.flatMap((diff) => diff.shapes),
      edges: diffs.flatMap((diff) => diff.edges),
      labels: diffs.flatMap((diff) => diff.labels),
      diagnostics: [],
    },
    moved: new Set(changes.flatMap((change) => [...change.moved])),
    planes: new Set(changes.map((change) => change.before.id)),
  };
}
