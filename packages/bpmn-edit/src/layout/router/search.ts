/**
 * A* search on the routing grid. A state is a grid node plus the direction the route arrived in, so a change of
 * direction can cost BEND_PENALTY: the result is the shortest route for its number of bends.
 */
import type { Point } from "../../geometry/geometry.ts";
import { BEND_PENALTY } from "../constants.ts";
import { type Grid, nodeIndex } from "./grid.ts";
import { type Direction, DIRECTIONS as DIRECTION_VALUES, opposite, VECTORS } from "./ports.ts";

const DIRECTIONS = DIRECTION_VALUES.length;
/** Direction and grid step (di, dj) of each move. */
const STEPS: readonly (readonly [Direction, number, number])[] = DIRECTION_VALUES.map((direction) => [
  direction,
  VECTORS[direction].x,
  VECTORS[direction].y,
]);

export interface Endpoint {
  readonly node: readonly [number, number];
  /** direction the route has when it starts here, or must have when it arrives here */
  readonly direction: Direction;
}

export interface SearchResult {
  readonly points: Point[];
  readonly cost: number;
}

/**
 * A minimal binary heap of states ordered by estimated total cost, in two parallel arrays (no allocation per entry).
 * Ties resolve exactly as a plain binary heap: a child only rises past a strictly larger parent, and sifting down
 * prefers the node itself, then its left child.
 */
class Queue {
  private readonly priorities: number[] = [];
  private readonly states: number[] = [];

  get size(): number {
    return this.states.length;
  }

  push(priority: number, state: number): void {
    const { priorities, states } = this;
    let index = states.length;
    priorities.push(priority);
    states.push(state);
    while (index > 0) {
      const parent = (index - 1) >> 1;
      if (priorities[parent]! <= priority) break;
      priorities[index] = priorities[parent]!;
      states[index] = states[parent]!;
      index = parent;
    }
    priorities[index] = priority;
    states[index] = state;
  }

  /** The lowest priority, or Infinity when the queue is empty. */
  peek(): number {
    return this.priorities[0] ?? Infinity;
  }

  /** Removes the entry with the lowest priority and returns its state. */
  pop(): number {
    const { priorities, states } = this;
    const top = states[0]!;
    const lastPriority = priorities.pop()!;
    const lastState = states.pop()!;
    const size = states.length;
    if (size === 0) return top;
    let index = 0;
    for (;;) {
      const left = 2 * index + 1;
      const right = left + 1;
      let smallest = index;
      let smallestPriority = lastPriority;
      if (left < size && priorities[left]! < smallestPriority) {
        smallest = left;
        smallestPriority = priorities[left]!;
      }
      if (right < size && priorities[right]! < smallestPriority) {
        smallest = right;
      }
      if (smallest === index) break;
      priorities[index] = priorities[smallest]!;
      states[index] = states[smallest]!;
      index = smallest;
    }
    priorities[index] = lastPriority;
    states[index] = lastState;
    return top;
  }
}

/** Whether a route can step from (i, j) to (ni, nj): the node is on the grid and free, and so is the segment. */
function canMove(grid: Grid, i: number, j: number, ni: number, nj: number, horizontal: boolean): boolean {
  if (ni < 0 || nj < 0 || ni >= grid.xs.length || nj >= grid.ys.length || grid.blocked[nodeIndex(grid, ni, nj)]) {
    return false;
  }
  const edge = nodeIndex(grid, Math.min(i, ni), Math.min(j, nj));
  return (horizontal ? grid.horizontalFree[edge] : grid.verticalFree[edge]) === 1;
}

function heuristic(grid: Grid, i: number, j: number, goal: Endpoint): number {
  const [gi, gj] = goal.node;
  return Math.abs(grid.xs[i]! - grid.xs[gi]!) + Math.abs(grid.ys[j]! - grid.ys[gj]!);
}

/** Pushes every cheaper neighbour state of `state`: a move in each direction but back, a turn costs BEND_PENALTY. */
function expand(
  grid: Grid,
  cost: Float64Array,
  previous: Int32Array,
  goal: Endpoint,
  state: number,
  queue: Queue,
): void {
  const width = grid.xs.length;
  const node = Math.floor(state / DIRECTIONS);
  const direction = state % DIRECTIONS;
  const i = node % width;
  const j = Math.floor(node / width);
  const back = opposite(direction as Direction);
  const base = cost[state]!;
  for (const [next, di, dj] of STEPS) {
    const ni = i + di;
    const nj = j + dj;
    const horizontal = dj === 0;
    if (next === back || !canMove(grid, i, j, ni, nj, horizontal)) continue;
    const edge = nodeIndex(grid, Math.min(i, ni), Math.min(j, nj));
    const length = Math.abs(grid.xs[ni]! - grid.xs[i]!) + Math.abs(grid.ys[nj]! - grid.ys[j]!);
    const penalty = horizontal ? grid.horizontalCost[edge]! : grid.verticalCost[edge]!;
    const total = base + length + penalty + (next === direction ? 0 : BEND_PENALTY);
    const target = (nj * width + ni) * DIRECTIONS + next;
    if (total < cost[target]!) {
      cost[target] = total;
      previous[target] = state;
      queue.push(total + heuristic(grid, ni, nj, goal), target);
    }
  }
}

function trace(grid: Grid, previous: Int32Array, end: number): Point[] {
  const points: Point[] = [];
  const width = grid.xs.length;
  for (let state = end; state !== -1; state = previous[state]!) {
    const node = Math.floor(state / DIRECTIONS);
    points.push({ x: grid.xs[node % width]!, y: grid.ys[Math.floor(node / width)]! });
  }
  return points.reverse();
}

/** The cheapest route from start to goal, or undefined when the goal cannot be reached on the grid. */
export function search(grid: Grid, start: Endpoint, goal: Endpoint): SearchResult | undefined {
  const states = grid.xs.length * grid.ys.length * DIRECTIONS;
  const cost = new Float64Array(states).fill(Infinity);
  const previous = new Int32Array(states).fill(-1);
  const first = nodeIndex(grid, start.node[0], start.node[1]) * DIRECTIONS + start.direction;
  const goalNode = nodeIndex(grid, goal.node[0], goal.node[1]);
  const queue = new Queue();
  cost[first] = 0;
  queue.push(0, first);
  let bestState = -1;
  let bestCost = Infinity;
  while (queue.size > 0 && queue.peek() < bestCost) {
    const state = queue.pop();
    if (Math.floor(state / DIRECTIONS) !== goalNode) {
      expand(grid, cost, previous, goal, state, queue);
      continue;
    }
    const total = cost[state]! + (state % DIRECTIONS === goal.direction ? 0 : BEND_PENALTY);
    if (total < bestCost) {
      bestState = state;
      bestCost = total;
    }
  }
  return bestState === -1 ? undefined : { points: trace(grid, previous, bestState), cost: bestCost };
}
