/**
 * Pools and lanes in the global layout: every pool lays out its process as one level whose rows fall into the bands
 * of its lanes; the pools stack in their current order, all as wide as the widest one, and every lane spans the width
 * of its pool from its name strip to the right border. A pool without a process keeps its height.
 */
import type { DiagramPlane, DiagramShape } from "../../diagram/plane.ts";
import type { Rect } from "../../geometry/geometry.ts";
import { ROUTE_MARGIN, type Size } from "../constants.ts";
import type { LevelLayout } from "./coordinates.ts";

/** Distance a flow passing the content of a lane along its border keeps from the border. */
const BORDER_CLEARANCE = 10;
/**
 * Space between the border of a lane (or a pool without lanes) and its content: the route margin plus the border
 * clearance, so a flow passing the content along the border keeps its distance to both.
 */
export const POOL_PADDING = ROUTE_MARGIN + BORDER_CLEARANCE;
/** Width of the name strip of a pool without lanes (the modeler's default). */
const POOL_HEADER = 30;
/** Smallest gap between two pools. */
const POOL_GAP = 30;

export interface PoolLayout {
  readonly pool: DiagramShape;
  /** the lanes that hold rows (no nested lane inside), top to bottom */
  readonly leaves: readonly DiagramShape[];
  /** undefined for a pool without a process */
  readonly layout?: LevelLayout;
}

export function leafLanes(plane: DiagramPlane, pool: DiagramShape): DiagramShape[] {
  const lanes = plane.shapes.filter((shape) => shape.type === "Lane" && shape.pool === pool.id);
  return lanes
    .filter((lane) => !lanes.some((child) => child.lane === lane.id))
    .sort((first, second) => first.bounds.y - second.bounds.y);
}

/** Width of the name strips left of the content: up to the lanes, or the pool header. */
function headerOf(pool: DiagramShape, leaves: readonly DiagramShape[]): number {
  const first = leaves[0];
  return first ? first.bounds.x - pool.bounds.x : POOL_HEADER;
}

function widthOf(entry: PoolLayout): number {
  return entry.layout ? headerOf(entry.pool, entry.leaves) + 2 * POOL_PADDING + entry.layout.width : 0;
}

/** Lanes that nest others: the union of the lanes inside them. */
function parentLanes(plane: DiagramPlane, placed: Map<string, Rect>): void {
  const lanes = plane.shapes.filter((shape) => shape.type === "Lane");
  const union = (id: string): Rect | undefined => {
    const own = placed.get(id);
    if (own) {
      return own;
    }
    const children = lanes.filter((lane) => lane.lane === id).flatMap((lane) => union(lane.id) ?? []);
    if (children.length === 0) {
      return undefined;
    }
    const top = Math.min(...children.map((child) => child.y));
    const bottom = Math.max(...children.map((child) => child.y + child.height));
    const x = Math.min(...children.map((child) => child.x));
    const right = Math.max(...children.map((child) => child.x + child.width));
    const merged = { x: x - POOL_HEADER, y: top, width: right - x + POOL_HEADER, height: bottom - top };
    placed.set(id, merged);
    return merged;
  };
  lanes.forEach((lane) => union(lane.id));
}

/**
 * Places the pools and lanes and the flow nodes of their processes; returns the new bounds. The first pool keeps its
 * top left corner.
 */
export function placePools(
  plane: DiagramPlane,
  pools: readonly PoolLayout[],
  sizeOf: (shape: DiagramShape) => Size,
): Map<string, Rect> {
  const placed = new Map<string, Rect>();
  const width = Math.max(...pools.map(widthOf), ...pools.map((entry) => entry.pool.bounds.width));
  const ordered = [...pools].sort((first, second) => first.pool.bounds.y - second.pool.bounds.y);
  let top = ordered[0]?.pool.bounds.y ?? 0;
  for (const { pool, leaves, layout } of ordered) {
    const x = pool.bounds.x;
    const height = layout ? layout.height : pool.bounds.height;
    placed.set(pool.id, { x, y: top, width, height });
    for (const lane of leaves) {
      const [bandTop, bandHeight] = layout?.bands.get(lane.id) ?? [0, height];
      const offset = lane.bounds.x - pool.bounds.x;
      placed.set(lane.id, { x: x + offset, y: top + bandTop, width: width - offset, height: bandHeight });
    }
    const left = x + headerOf(pool, leaves) + POOL_PADDING;
    layout?.positions.forEach((point, id) => {
      const shape = plane.shapes.find((candidate) => candidate.id === id);
      if (shape) {
        placed.set(id, { ...sizeOf(shape), x: Math.round(left + point.x), y: Math.round(top + point.y) });
      }
    });
    top += height + POOL_GAP;
  }
  parentLanes(plane, placed);
  return placed;
}
