/**
 * The routing grid: every obstacle border and every port coordinate is a grid line (a Hanan grid). An orthogonal
 * route that avoids the obstacles and is shortest for its number of bends runs along these lines (Wybrow et al.,
 * Orthogonal Connector Routing, 2009).
 */
import type { Point, Rect, Segment } from "../../geometry/geometry.ts";
import { collinearOverlap, EPSILON, segmentsCross } from "../../geometry/geometry.ts";
import { CROSSING_PENALTY, OVERLAP_PENALTY } from "../constants.ts";

export interface Grid {
  readonly xs: readonly number[];
  readonly ys: readonly number[];
  /** node (i, j) lies inside an obstacle */
  readonly blocked: Uint8Array;
  /** the segment from (i, j) to (i + 1, j) is free */
  readonly horizontalFree: Uint8Array;
  /** the segment from (i, j) to (i, j + 1) is free */
  readonly verticalFree: Uint8Array;
  /** extra cost of the segment from (i, j) to (i + 1, j) for crossing or covering other flows */
  readonly horizontalCost: Float64Array;
  /** extra cost of the segment from (i, j) to (i, j + 1) */
  readonly verticalCost: Float64Array;
}

function inside(point: Point, rect: Rect): boolean {
  return (
    point.x > rect.x + EPSILON &&
    point.x < rect.x + rect.width - EPSILON &&
    point.y > rect.y + EPSILON &&
    point.y < rect.y + rect.height - EPSILON
  );
}

function coordinates(values: readonly number[], low: number, high: number): number[] {
  const sorted = [...new Set(values.filter((value) => value >= low && value <= high).map(Math.round))];
  return sorted.sort((first, second) => first - second);
}

export function nodeIndex(grid: Grid, i: number, j: number): number {
  return j * grid.xs.length + i;
}

function free(point: Point, obstacles: readonly Rect[]): number {
  return obstacles.some((rect) => inside(point, rect)) ? 0 : 1;
}

/** Edge length of a cell of the flow index. */
const CELL = 64;

/**
 * The flows of a window hashed into square cells by their bounding box, so a grid segment is only tested against the
 * flows near it. It only preselects candidates: the exact tests stay segmentsCross and collinearOverlap.
 */
interface FlowIndex {
  readonly flows: readonly Segment[];
  readonly cells: Map<number, number[]>;
  /** per flow: the query that last saw it, to test each flow once per query */
  readonly seen: Uint32Array;
  query: number;
}

const cellKey = (cx: number, cy: number): number => cx * 1_000_003 + cy;

function cellRange(low: number, high: number): [number, number] {
  return [Math.floor((low - EPSILON) / CELL), Math.floor((high + EPSILON) / CELL)];
}

function indexFlows(flows: readonly Segment[]): FlowIndex {
  const cells = new Map<number, number[]>();
  flows.forEach(([start, end], index) => {
    const [x0, x1] = cellRange(Math.min(start.x, end.x), Math.max(start.x, end.x));
    const [y0, y1] = cellRange(Math.min(start.y, end.y), Math.max(start.y, end.y));
    for (let cx = x0; cx <= x1; cx++) {
      for (let cy = y0; cy <= y1; cy++) {
        const key = cellKey(cx, cy);
        const bucket = cells.get(key);
        if (bucket) bucket.push(index);
        else cells.set(key, [index]);
      }
    }
  });
  return { flows, cells, seen: new Uint32Array(flows.length), query: 0 };
}

/** Penalty of one grid segment for the flows it crosses or covers. */
function flowCost(segment: Segment, index: FlowIndex): number {
  const [start, end] = segment;
  const [x0, x1] = cellRange(Math.min(start.x, end.x), Math.max(start.x, end.x));
  const [y0, y1] = cellRange(Math.min(start.y, end.y), Math.max(start.y, end.y));
  const query = ++index.query;
  let cost = 0;
  for (let cx = x0; cx <= x1; cx++) {
    for (let cy = y0; cy <= y1; cy++) {
      for (const candidate of index.cells.get(cellKey(cx, cy)) ?? []) {
        if (index.seen[candidate] === query) continue;
        index.seen[candidate] = query;
        const flow = index.flows[candidate]!;
        if (segmentsCross(segment, flow)) {
          cost += CROSSING_PENALTY;
        } else if (collinearOverlap(segment, flow) > EPSILON) {
          cost += OVERLAP_PENALTY;
        }
      }
    }
  }
  return cost;
}

function inWindow(segment: Segment, window: Rect): boolean {
  const [start, end] = segment;
  return (
    Math.max(start.x, end.x) >= window.x &&
    Math.min(start.x, end.x) <= window.x + window.width &&
    Math.max(start.y, end.y) >= window.y &&
    Math.min(start.y, end.y) <= window.y + window.height
  );
}

function intersects(rect: Rect, window: Rect): boolean {
  return (
    rect.x < window.x + window.width &&
    rect.x + rect.width > window.x &&
    rect.y < window.y + window.height &&
    rect.y + rect.height > window.y
  );
}

/** Grid lines: obstacle borders, port coordinates and the window origin, inside the window. */
function lines(obstacles: readonly Rect[], points: readonly Point[], window: Rect, axis: "x" | "y"): number[] {
  const size = axis === "x" ? "width" : "height";
  const values = [
    ...obstacles.flatMap((rect) => [rect[axis], rect[axis] + rect[size]]),
    ...points.map((point) => point[axis]),
    window[axis],
  ];
  return coordinates(values, window[axis], window[axis] + window[size]);
}

/** Blocked nodes, free segments and flow penalties of every grid node. */
function fill(grid: Grid, obstacles: readonly Rect[], flows: readonly Segment[]): void {
  const { xs, ys } = grid;
  const flowIndex = indexFlows(flows);
  ys.forEach((y, j) => {
    xs.forEach((x, i) => {
      const index = nodeIndex(grid, i, j);
      grid.blocked[index] = 1 - free({ x, y }, obstacles);
      const right = xs[i + 1];
      const below = ys[j + 1];
      if (right !== undefined) {
        grid.horizontalFree[index] = free({ x: (x + right) / 2, y }, obstacles);
        grid.horizontalCost[index] = flowCost(
          [
            { x, y },
            { x: right, y },
          ],
          flowIndex,
        );
      }
      if (below !== undefined) {
        grid.verticalFree[index] = free({ x, y: (y + below) / 2 }, obstacles);
        grid.verticalCost[index] = flowCost(
          [
            { x, y },
            { x, y: below },
          ],
          flowIndex,
        );
      }
    });
  });
}

export function buildGrid(
  obstacles: readonly Rect[],
  points: readonly Point[],
  window: Rect,
  flows: readonly Segment[] = [],
): Grid {
  const relevant = obstacles.filter((rect) => intersects(rect, window));
  const xs = lines(relevant, points, window, "x");
  const ys = lines(relevant, points, window, "y");
  const size = xs.length * ys.length;
  const grid: Grid = {
    xs,
    ys,
    blocked: new Uint8Array(size),
    horizontalFree: new Uint8Array(size),
    verticalFree: new Uint8Array(size),
    horizontalCost: new Float64Array(size),
    verticalCost: new Float64Array(size),
  };
  fill(
    grid,
    relevant,
    flows.filter((flow) => inWindow(flow, window)),
  );
  return grid;
}
