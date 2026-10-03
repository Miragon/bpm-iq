/**
 * Overlap removal for a whole plane, from the inside out: the content of every expanded sub-process is separated
 * first and the sub-process grows or shrinks around it; then the sub-process takes part in the separation of its own
 * level as one shape of its new size, and its content moves with it. The top level stays in its pools and lanes.
 * Boundary events stay on the border of their host.
 */
import type { DiagramPlane, DiagramShape } from "../diagram/plane.ts";
import type { Rect } from "../geometry/geometry.ts";
import { compact } from "./compact.ts";
import { alignEndEvents } from "./end-events.ts";
import { framesFor, subProcessFrame } from "./frames.ts";
import { fixSides, settleShifted } from "./reroute.ts";
import { moveShape } from "./space.ts";
import { type FrameProvider, solveGroup } from "./vpsc.ts";

type Delta = readonly [number, number];

/** Pools, lanes and groups are frames; an expanded sub-process is a frame for its content and a shape on its level. */
function isSubProcess(shape: DiagramShape): boolean {
  return shape.container && /SubProcess$|^Transaction$/.test(shape.type);
}

function isFree(shape: DiagramShape): boolean {
  return !shape.attachedTo && (!shape.container || isSubProcess(shape));
}

function depthOf(id: string, byId: ReadonlyMap<string, DiagramShape>): number {
  let depth = 0;
  for (let parent = byId.get(id)?.parent; parent !== undefined; parent = byId.get(parent)?.parent) {
    depth++;
  }
  return depth;
}

interface Separation {
  /** displacement of every free shape within its own level */
  readonly local: Map<string, Delta>;
  /** new bounds of every frame after the separation of its content, before its own level moves it */
  readonly frames: Map<string, Rect>;
}

/** Separates every level, the deepest sub-processes first, the plane with its pools and lanes last. */
function separateLevels(plane: DiagramPlane, pinned: ReadonlySet<string>): Separation {
  const byId = new Map(plane.shapes.map((shape) => [shape.id, shape]));
  const levels = [...new Set(plane.shapes.filter(isFree).map((shape) => shape.parent ?? ""))];
  levels.sort(
    (first, second) => depthOf(second, byId) - depthOf(first, byId) || (first === "" ? 1 : 0) - (second === "" ? 1 : 0),
  );
  const result: Separation = { local: new Map(), frames: new Map() };
  const boundsOf = (id: string): Rect | undefined => result.frames.get(id) ?? byId.get(id)?.bounds;
  for (const level of levels) {
    const members = plane.shapes
      .filter((shape) => isFree(shape) && (shape.parent ?? "") === level)
      .map((shape) => ({ ...shape, bounds: boundsOf(shape.id) ?? shape.bounds }));
    const sub = byId.get(level);
    const frames: FrameProvider = sub
      ? (placed, axis) => subProcessFrame(sub, placed, axis)
      : (placed, axis) => framesFor(plane.shapes, placed, axis);
    const solution = solveGroup(members, pinned, frames, boundsOf);
    solution.deltas.forEach((delta, id) => result.local.set(id, delta));
    solution.frames.forEach((bounds, id) => result.frames.set(id, bounds));
  }
  return result;
}

/** The displacement of a free shape: its own at its level plus those of the sub-processes around it. */
function totalDelta(
  shape: DiagramShape,
  byId: ReadonlyMap<string, DiagramShape>,
  local: ReadonlyMap<string, Delta>,
): Delta {
  let [dx, dy] = local.get(shape.id) ?? [0, 0];
  for (let parent = shape.parent; parent !== undefined; parent = byId.get(parent)?.parent) {
    const [px, py] = local.get(parent) ?? [0, 0];
    dx += px;
    dy += py;
  }
  return [dx, dy];
}

/**
 * The shift of a boundary event on one axis: it stays on the far border (bottom, right) of its host when it sits
 * there, otherwise it keeps its distance to the near border. A host that only moved shifts both borders alike; a
 * sub-process that grew moves them apart.
 */
function followBorder(event: Rect, before: Rect, after: Rect, axis: "x" | "y"): number {
  const size = axis === "x" ? "width" : "height";
  const centre = event[axis] + event[size] / 2;
  const far = before[axis] + before[size];
  const onFarBorder = Math.abs(centre - far) <= event[size] / 2;
  return onFarBorder ? after[axis] + after[size] - far : after[axis] - before[axis];
}

function sameRect(first: Rect, second: Rect): boolean {
  return first.x === second.x && first.y === second.y && first.width === second.width && first.height === second.height;
}

/**
 * Removes overlaps and too small gaps; pinned shapes stay where they are, flow nodes stay in their sub-process, lane
 * and pool, and these grow (or shrink) around them. Flows are not touched.
 */
export function separate(
  plane: DiagramPlane,
  pinned: ReadonlySet<string> = new Set(),
): { plane: DiagramPlane; moved: Set<string> } {
  const byId = new Map(plane.shapes.map((shape) => [shape.id, shape]));
  const { local, frames } = separateLevels(plane, pinned);
  const placedShape = (shape: DiagramShape): DiagramShape => {
    const [dx, dy] = totalDelta(shape, byId, local);
    const bounds = frames.get(shape.id);
    // a sub-process got its new size at its own level; its level (and the levels around it) then moved it
    const resized = bounds && isSubProcess(shape) ? { ...shape, bounds } : shape;
    if (bounds && !isSubProcess(shape)) {
      return { ...shape, bounds };
    }
    return dx === 0 && dy === 0 ? resized : moveShape(resized, dx, dy);
  };
  const hosts = new Map(
    plane.shapes.filter((shape) => !shape.attachedTo).map((shape) => [shape.id, placedShape(shape)]),
  );
  const shapes = plane.shapes.map((shape) => {
    const [before, after] = [byId.get(shape.attachedTo ?? ""), hosts.get(shape.attachedTo ?? "")];
    if (!before || !after) {
      return hosts.get(shape.id) ?? shape;
    }
    const dx = followBorder(shape.bounds, before.bounds, after.bounds, "x");
    const dy = followBorder(shape.bounds, before.bounds, after.bounds, "y");
    return dx === 0 && dy === 0 ? shape : moveShape(shape, dx, dy);
  });
  const moved = new Set(
    shapes
      .filter((shape, index) => !sameRect(shape.bounds, plane.shapes[index]?.bounds ?? shape.bounds))
      .map((shape) => shape.id),
  );
  return { plane: { ...plane, shapes }, moved };
}

/**
 * Tidy: overlap removal for the whole plane; the flows of the moved shapes stretch or, where needed, get new routes.
 * Then flows that leave a shape on a wrong side get new routes, the end events line up in one column on the right
 * (both only where that adds no crossing), and empty strips wider than the spacing of the plane close.
 */
export function tidy(plane: DiagramPlane): { plane: DiagramPlane; moved: Set<string> } {
  const separated = separate(plane);
  const sided = fixSides(settleShifted(plane, separated.plane, separated.moved));
  const aligned = alignEndEvents(sided.plane);
  const compacted = compact(aligned.plane);
  return { plane: compacted.plane, moved: new Set([...separated.moved, ...aligned.moved, ...compacted.moved]) };
}
