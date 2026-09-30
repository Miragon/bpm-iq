/**
 * Relayout of the smallest SESE fragment around some flow nodes: the interior is laid out anew in columns and rows
 * (layered.ts) and the rest of the plane makes room in one of two ways; the caller keeps the better one by score:
 *
 * - space: everything right of the exit (and below the fragment, if needed) moves by one distance, the way the
 *   space tool of the modeler works; flows between shifted shapes stay as they are
 * - separate: the exit moves right as far as needed, then every other shape gives way with the smallest
 *   displacement (VPSC with the laid out shapes pinned)
 *
 * A fragment drawn backwards can only be turned to read left to right together with its surroundings, so the
 * smallest enclosing fragment drawn forwards is laid out as well.
 */
import type { DiagramPlane, DiagramShape } from "../../diagram/plane.ts";
import type { Point } from "../../geometry/geometry.ts";
import { EPSILON, rectGap, rectsOverlap } from "../../geometry/geometry.ts";
import { outsideFrames } from "../../metrics/rules.ts";
import { compact } from "../compact.ts";
import { COLUMN_GAP, MIN_SHAPE_GAP } from "../constants.ts";
import { settle, settleShifted } from "../reroute.ts";
import { center, makeSpace, moveShape, shapesById } from "../space.ts";
import { separate } from "../tidy.ts";
import { dockBoundaryEvents } from "./boundaries.ts";
import { VIRTUAL_START } from "./flow-graph.ts";
import { enclosingFragments, type Fragment } from "./fragment.ts";
import { originOf, placeInterior, type Placement } from "./layered.ts";
import { spacingOf } from "./spacing.ts";

export interface Variant {
  readonly plane: DiagramPlane;
  readonly moved: Set<string>;
}

interface Prepared {
  readonly fragment: Fragment;
  readonly placement: Placement;
  /** interior nodes and their boundary events */
  readonly inside: ReadonlySet<string>;
  /** the plane with the interior at its new places */
  readonly placed: DiagramPlane;
  /** the right edge and centre line of the entry */
  readonly origin: Point;
}

function virtualOrigin(plane: DiagramPlane, fragment: Fragment): Point {
  const starts = plane.shapes.filter((shape) => fragment.interior.has(shape.id) && shape.type === "StartEvent");
  const first = [...starts].sort((a, b) => a.bounds.y - b.bounds.y)[0];
  const left = Math.min(...plane.shapes.filter((shape) => !shape.container).map((shape) => shape.bounds.x));
  return { x: left - COLUMN_GAP, y: first ? center(first.bounds).y : 0 };
}

/** The delta of the nearest shape around `shape` (its host, its sub-process, theirs) that the layering placed. */
function inherited(
  shape: DiagramShape,
  deltas: ReadonlyMap<string, readonly [number, number]>,
  byId: ReadonlyMap<string, DiagramShape>,
): readonly [number, number] {
  for (let id: string | undefined = shape.attachedTo ?? shape.id; id !== undefined;) {
    const delta = deltas.get(id);
    if (delta) {
      return delta;
    }
    const current: DiagramShape | undefined = byId.get(id);
    id = current?.attachedTo ?? current?.parent;
  }
  return [0, 0];
}

/**
 * Moves the interior nodes to their new centres; boundary events follow their host, the content of an expanded
 * sub-process follows the sub-process. A node in another lane than the entry keeps its height: the rows of the
 * layering belong to the lane of the entry.
 */
function moveInterior(plane: DiagramPlane, centres: ReadonlyMap<string, Point>, entry: string): DiagramPlane {
  const byId = shapesById(plane);
  const lane = byId.get(entry)?.lane;
  const deltas = new Map(
    plane.shapes.flatMap((shape) => {
      const target = centres.get(shape.id);
      const now = center(shape.bounds);
      const dy = shape.lane === lane && target ? target.y - now.y : 0;
      return target ? [[shape.id, [target.x - now.x, dy] as const]] : [];
    }),
  );
  return {
    ...plane,
    shapes: plane.shapes.map((shape) => {
      const [dx, dy] = inherited(shape, deltas, byId);
      return dx === 0 && dy === 0 ? shape : moveShape(shape, dx, dy);
    }),
  };
}

function members(plane: DiagramPlane, fragment: Fragment): Set<string> {
  const ids = new Set(fragment.interior);
  plane.shapes.filter((shape) => shape.attachedTo && ids.has(shape.attachedTo)).forEach((shape) => ids.add(shape.id));
  return ids;
}

function prepare(plane: DiagramPlane, fragment: Fragment): Prepared {
  const entry = shapesById(plane).get(fragment.entry);
  const origin = fragment.entry === VIRTUAL_START || !entry ? virtualOrigin(plane, fragment) : originOf(entry);
  const placement = placeInterior(plane, fragment, origin, spacingOf(plane));
  return {
    fragment,
    placement,
    inside: members(plane, fragment),
    placed: dockBoundaryEvents(moveInterior(plane, placement.centres, fragment.entry), fragment.interior),
    origin,
  };
}

/** Shapes outside the fragment that the laid out interior now overlaps or comes too close to. */
function colliding(plane: DiagramPlane, inside: ReadonlySet<string>): DiagramShape[] {
  const interior = plane.shapes.filter((shape) => inside.has(shape.id));
  return plane.shapes.filter(
    (shape) =>
      !shape.container &&
      !inside.has(shape.id) &&
      interior.some(
        (node) => rectsOverlap(node.bounds, shape.bounds) || rectGap(node.bounds, shape.bounds) < MIN_SHAPE_GAP,
      ),
  );
}

/** Moves the shapes in the way of the laid out interior down (below the entry row) and up (above it). */
function makeRoom(plane: DiagramPlane, prepared: Prepared, moved: Set<string>): DiagramPlane {
  const { inside, fragment, origin } = prepared;
  const interior = plane.shapes.filter((shape) => inside.has(shape.id));
  const keep = new Set([...inside, fragment.entry]);
  const blocking = colliding(plane, inside);
  const below = blocking.filter((shape) => center(shape.bounds).y >= origin.y);
  const above = blocking.filter((shape) => center(shape.bounds).y < origin.y);
  let current = plane;
  if (below.length > 0) {
    const line = Math.min(...below.map((shape) => shape.bounds.y));
    const bottom = Math.max(...interior.map((shape) => shape.bounds.y + shape.bounds.height));
    const shifted = makeSpace(current, { axis: "y", line, delta: bottom + MIN_SHAPE_GAP - line }, keep);
    shifted.moved.forEach((id) => moved.add(id));
    current = shifted.plane;
  }
  if (above.length > 0) {
    const line = Math.max(...above.map((shape) => shape.bounds.y + shape.bounds.height));
    const top = Math.min(...interior.map((shape) => shape.bounds.y));
    const shifted = makeSpace(current, { axis: "y", line, delta: top - MIN_SHAPE_GAP - line, side: "before" }, keep);
    shifted.moved.forEach((id) => moved.add(id));
    current = shifted.plane;
  }
  return current;
}

/** How far the exit has to move up or down to sit on the row of the entry (a block starts and ends on one line). */
function exitOffset(plane: DiagramPlane, prepared: Prepared): number {
  const exit = shapesById(plane).get(prepared.fragment.exit);
  return exit ? prepared.origin.y - center(exit.bounds).y : 0;
}

function moveExit(plane: DiagramPlane, exit: string, dx: number, dy: number): DiagramPlane {
  return {
    ...plane,
    shapes: plane.shapes.map((shape) =>
      shape.id === exit || shape.attachedTo === exit ? moveShape(shape, dx, dy) : shape,
    ),
  };
}

/** The plane with the exit on the row of the entry, unless another shape is in the way there. */
function alignExit(plane: DiagramPlane, prepared: Prepared): DiagramPlane | undefined {
  const exit = prepared.fragment.exit;
  const dy = exitOffset(plane, prepared);
  if (Math.abs(dy) < EPSILON) {
    return undefined;
  }
  const aligned = moveExit(plane, exit, 0, dy);
  const blocked = colliding(aligned, new Set([exit])).some((shape) => shape.attachedTo !== exit);
  return blocked ? undefined : aligned;
}

function spaceVariant(original: DiagramPlane, prepared: Prepared): Variant {
  const { fragment, placement, inside } = prepared;
  const exit = shapesById(original).get(fragment.exit);
  const moved = new Set(inside);
  let current = prepared.placed;
  const dx = exit ? placement.exitX - exit.bounds.x : 0;
  if (exit && dx > 0) {
    const shifted = makeSpace(current, { axis: "x", line: exit.bounds.x, delta: dx }, inside);
    current = shifted.plane;
    shifted.moved.forEach((id) => moved.add(id));
  }
  current = makeRoom(current, prepared, moved);
  const aligned = alignExit(current, prepared);
  const placedIds = new Set([...inside, ...(aligned ? [fragment.exit] : [])]);
  placedIds.forEach((id) => moved.add(id));
  // shapes the space tool only shifted keep valid flows; the placed interior (and a realigned exit) needs new routes
  return { plane: settle(aligned ?? current, placedIds), moved };
}

function separateVariant(prepared: Prepared): Variant {
  const { fragment, placement, inside, placed } = prepared;
  const exit = placed.shapes.find((shape) => shape.id === fragment.exit);
  const dx = exit ? Math.max(0, placement.exitX - exit.bounds.x) : 0;
  const dy = exitOffset(placed, prepared);
  const withExit = moveExit(placed, fragment.exit, dx, dy);
  const separated = separate(withExit, new Set([...inside, fragment.entry, fragment.exit]));
  const exitMoved = dx > 0 || Math.abs(dy) >= EPSILON;
  const placedIds = new Set([...inside, ...(exitMoved ? [fragment.exit] : [])]);
  const shifted = settleShifted(withExit, separated.plane, separated.moved);
  return { plane: settle(shifted, placedIds), moved: new Set([...placedIds, ...separated.moved]) };
}

/**
 * True when the exit lies right of the entry. For a fragment drawn backwards (the exit left of the entry, a loop
 * back to the start) the space tool would shift almost the whole plane; only minimal displacement makes sense.
 */
function drawnForwards(plane: DiagramPlane, fragment: Fragment): boolean {
  const byId = shapesById(plane);
  const entry = byId.get(fragment.entry);
  const exit = byId.get(fragment.exit);
  return !entry || !exit || exit.bounds.x >= entry.bounds.x + entry.bounds.width;
}

function variantsOf(plane: DiagramPlane, fragment: Fragment): Variant[] {
  const prepared = prepare(plane, fragment);
  const separated = separateVariant(prepared);
  return drawnForwards(plane, fragment) ? [spaceVariant(plane, prepared), separated] : [separated];
}

/** The ways of making room for the laid out fragment; the caller keeps the one with the best score. */
export function relayoutVariants(plane: DiagramPlane, ids: readonly string[]): Variant[] {
  const [smallest, ...wider] = enclosingFragments(plane, ids);
  if (!smallest) {
    return [];
  }
  const forwards = drawnForwards(plane, smallest)
    ? undefined
    : wider.find((fragment) => drawnForwards(plane, fragment));
  return [smallest, ...(forwards ? [forwards] : [])]
    .flatMap((fragment) => variantsOf(plane, fragment))
    .map(framed)
    .map((variant) => {
      const compacted = compact(variant.plane);
      return { plane: compacted.plane, moved: new Set([...variant.moved, ...compacted.moved]) };
    });
}

/**
 * On a plane with pools or expanded sub-processes the flow nodes outside their frame go back into it, and the frames
 * fit around their content; every shape that already lies in its frame stays where the variant put it.
 */
function framed(variant: Variant): Variant {
  if (!variant.plane.shapes.some((shape) => shape.container)) {
    return variant;
  }
  const outside = new Set(outsideFrames(variant.plane).map((shape) => shape.id));
  const pinned = new Set(variant.plane.shapes.filter((shape) => !outside.has(shape.id)).map((shape) => shape.id));
  const separated = separate(variant.plane, pinned);
  return {
    plane: settleShifted(variant.plane, separated.plane, separated.moved),
    moved: new Set([...variant.moved, ...separated.moved]),
  };
}
