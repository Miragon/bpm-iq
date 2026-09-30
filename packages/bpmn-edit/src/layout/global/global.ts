/**
 * Global layout of a plane (mode layout): every level is laid out anew, the current geometry only orders equal
 * branches. Expanded sub-processes first, from the inside out, each as large as its content; then the plane, in its
 * pools and lanes. Every sequence flow except a loop return runs left to right; the end events share the last column.
 * Then boundary events dock, artifacts follow their node, all flows are routed anew (global/routing.ts), and tidy
 * removes what is left over (overlaps, flows that leave a shape on a wrong side, empty strips).
 */
import { type DiagramPlane, type DiagramShape, levelOf } from "../../diagram/plane.ts";
import type { Rect } from "../../geometry/geometry.ts";
import { isBackground } from "../../metrics/rules.ts";
import type { Size } from "../constants.ts";
import { dockBoundaryEvents } from "../relayout/boundaries.ts";
import { relabel } from "../reroute.ts";
import { score } from "../score.ts";
import { moveShape, shapesById } from "../space.ts";
import { tidy } from "../tidy.ts";
import { isArtifact, placeArtifacts, straightAssociations } from "./artifacts.ts";
import { type Bands, type LevelLayout, placeLevel } from "./coordinates.ts";
import { gridOf } from "./level.ts";
import { leafLanes, placePools, POOL_PADDING, type PoolLayout } from "./pools.ts";
import { routeFlows } from "./routing.ts";

/** Space between the border of an expanded sub-process and its content; more on top for its name. */
const SUB_PROCESS_PADDING = { left: 30, top: 40, right: 30, bottom: 30 };

const ONE_BAND: Bands = { of: () => "", order: [""], padding: 0 };

function isNode(shape: DiagramShape): boolean {
  return !isBackground(shape) && !isArtifact(shape);
}

function depthOf(id: string, byId: ReadonlyMap<string, DiagramShape>): number {
  let depth = 0;
  for (let parent = byId.get(id)?.parent; parent !== undefined; parent = byId.get(parent)?.parent) {
    depth++;
  }
  return depth;
}

interface Levels {
  readonly members: ReadonlyMap<string, DiagramShape[]>;
  readonly sizes: Map<string, Size>;
  readonly inner: Map<string, LevelLayout>;
}

function sizeFor(levels: Levels): (shape: DiagramShape) => Size {
  return (shape) => levels.sizes.get(shape.id) ?? { width: shape.bounds.width, height: shape.bounds.height };
}

/** Lays out the content of every expanded sub-process, the deepest first, and sizes the sub-process around it. */
function layoutSubProcesses(plane: DiagramPlane, levels: Levels): void {
  const byId = shapesById(plane);
  const subs = [...levels.members.keys()].filter((id) => {
    const shape = byId.get(id);
    return shape !== undefined && shape.container && !isBackground(shape);
  });
  subs.sort((first, second) => depthOf(second, byId) - depthOf(first, byId));
  for (const sub of subs) {
    const members = levels.members.get(sub) ?? [];
    const layout = placeLevel(members, gridOf(plane, members), sizeFor(levels), ONE_BAND);
    levels.inner.set(sub, layout);
    const { left, top, right, bottom } = SUB_PROCESS_PADDING;
    levels.sizes.set(sub, { width: layout.width + left + right, height: layout.height + top + bottom });
  }
}

/** The top level without pools: one band, the content keeps the top left corner of the current drawing. */
function placePlain(plane: DiagramPlane, levels: Levels): Map<string, Rect> {
  const members = levels.members.get("") ?? [];
  const sizeOf = sizeFor(levels);
  const layout = placeLevel(members, gridOf(plane, members), sizeOf, ONE_BAND);
  const nodes = members.filter((shape) => !shape.attachedTo);
  const left = Math.min(...nodes.map((shape) => shape.bounds.x));
  const top = Math.min(...nodes.map((shape) => shape.bounds.y));
  const placed = new Map<string, Rect>();
  for (const shape of nodes) {
    const point = layout.positions.get(shape.id);
    if (point) {
      placed.set(shape.id, { ...sizeOf(shape), x: Math.round(left + point.x), y: Math.round(top + point.y) });
    }
  }
  return placed;
}

/** The top level with pools: every pool lays out its process, its lanes are the bands of its rows. */
function placePooled(
  plane: DiagramPlane,
  levels: Levels,
  pools: readonly DiagramShape[],
  laneRows: boolean,
): Map<string, Rect> {
  const sizeOf = sizeFor(levels);
  const entries: PoolLayout[] = pools.map((pool) => {
    const members = levels.members.get(pool.id) ?? [];
    const leaves = leafLanes(plane, pool);
    if (members.length === 0) {
      return { pool, leaves };
    }
    const order = leaves.length > 0 ? leaves.map((lane) => lane.id) : [""];
    const leafIds = new Set(order);
    const of = (shape: DiagramShape): string => (shape.lane && leafIds.has(shape.lane) ? shape.lane : (order[0] ?? ""));
    const layout = placeLevel(members, gridOf(plane, members, laneRows), sizeOf, { of, order, padding: POOL_PADDING });
    return { pool, leaves, layout };
  });
  return placePools(plane, entries, sizeOf);
}

/** The content of every expanded sub-process inside its new bounds, the outermost first. */
function placeSubProcessContent(
  levels: Levels,
  placed: Map<string, Rect>,
  byId: ReadonlyMap<string, DiagramShape>,
): void {
  const subs = [...levels.inner.keys()].sort((first, second) => depthOf(first, byId) - depthOf(second, byId));
  const sizeOf = sizeFor(levels);
  for (const sub of subs) {
    const frame = placed.get(sub);
    levels.inner.get(sub)?.positions.forEach((point, id) => {
      const shape = byId.get(id);
      if (frame && shape) {
        const x = frame.x + SUB_PROCESS_PADDING.left + point.x;
        const y = frame.y + SUB_PROCESS_PADDING.top + point.y;
        placed.set(id, { ...sizeOf(shape), x: Math.round(x), y: Math.round(y) });
      }
    });
  }
}

/** Boundary events keep their offset to the top left corner of their host; docking puts them on its border. */
function placeBoundaryEvents(
  plane: DiagramPlane,
  placed: Map<string, Rect>,
  byId: ReadonlyMap<string, DiagramShape>,
): void {
  for (const event of plane.shapes.filter((shape) => shape.attachedTo)) {
    const [before, after] = [byId.get(event.attachedTo ?? "")?.bounds, placed.get(event.attachedTo ?? "")];
    if (before && after) {
      placed.set(event.id, {
        ...event.bounds,
        x: event.bounds.x + after.x - before.x,
        y: event.bounds.y + after.y - before.y,
      });
    }
  }
}

/** The plane with the new bounds; external labels move with their shape. */
function withBounds(plane: DiagramPlane, placed: ReadonlyMap<string, Rect>): DiagramPlane {
  return {
    ...plane,
    shapes: plane.shapes.map((shape) => {
      const bounds = placed.get(shape.id);
      if (!bounds) {
        return shape;
      }
      const moved = moveShape(shape, bounds.x - shape.bounds.x, bounds.y - shape.bounds.y);
      return { ...moved, bounds };
    }),
  };
}

function layoutOnce(plane: DiagramPlane, laneRows: boolean): DiagramPlane {
  const byId = shapesById(plane);
  const members = new Map<string, DiagramShape[]>();
  plane.shapes
    .filter(isNode)
    .forEach((shape) => members.set(levelOf(shape), [...(members.get(levelOf(shape)) ?? []), shape]));
  const levels: Levels = { members, sizes: new Map(), inner: new Map() };
  layoutSubProcesses(plane, levels);
  const pools = plane.shapes.filter((shape) => shape.type === "Participant");
  const placed = pools.length > 0 ? placePooled(plane, levels, pools, laneRows) : placePlain(plane, levels);
  placeSubProcessContent(levels, placed, byId);
  placeBoundaryEvents(plane, placed, byId);
  placeArtifacts(plane, placed);
  const hosts = new Set(plane.shapes.flatMap((shape) => (shape.attachedTo ? [shape.attachedTo] : [])));
  const docked = dockBoundaryEvents(withBounds(plane, placed), hosts, true);
  const routed = straightAssociations(routeFlows(docked));
  const labelled = relabel(routed, new Set([...plane.shapes, ...plane.edges].map((element) => element.id)));
  return relabel(tidy(labelled).plane, new Set(plane.edges.map((edge) => edge.id)));
}

/**
 * The plane laid out anew. With lanes, the rows are computed twice — a node continues its predecessor's row only as
 * its first successor, or also as the first successor in the predecessor's lane (a branch that stays in its lane runs
 * straight on while the others leave for their bands) — and the variant with the better score is kept.
 */
export function layoutGlobally(plane: DiagramPlane): DiagramPlane {
  const plain = layoutOnce(plane, false);
  if (!laneRowsDiffer(plane)) {
    return plain;
  }
  const laned = layoutOnce(plane, true);
  return score(laned) < score(plain) ? laned : plain;
}

/**
 * Whether the lane rule can change a row at all: only a node with successors both in its own lane and in another one
 * continues its row differently; without such a node the second layout would be the first again.
 */
function laneRowsDiffer(plane: DiagramPlane): boolean {
  const byId = shapesById(plane);
  const successors = new Map<string, string[]>();
  for (const edge of plane.edges) {
    if (edge.type === "SequenceFlow" && edge.source && edge.target) {
      successors.set(edge.source, [...(successors.get(edge.source) ?? []), edge.target]);
    }
  }
  return [...successors].some(([source, targets]) => {
    const lane = byId.get(source)?.lane;
    const lanes = targets.map((target) => byId.get(target)?.lane);
    return lane !== undefined && lanes.includes(lane) && lanes.some((other) => other !== lane);
  });
}
