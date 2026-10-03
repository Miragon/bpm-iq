/**
 * Rows (Sugiyama, steps three and four in the form BPMN needs): the successor drawn on the line of its predecessor
 * continues the row (the happy path runs straight); every further successor and the flows of a boundary event open a
 * new row next to the row they branch off from: above it when their author drew them above, otherwise (always for a
 * boundary event) below it. Of several branches on one side the one that rejoins soonest sits nearest, so the flows of
 * the longer ones pass around it; this nesting keeps a structured process free of crossings.
 */
import type { DiagramShape } from "../../diagram/plane.ts";
import { type Acyclic, centreY } from "./feedback.ts";

/** A row opened by a branch: the row it branches off from, the side and the column of the branching node. */
export interface OpenedRow {
  readonly id: number;
  readonly parent: number;
  readonly above: boolean;
  readonly from: number;
  /** where its first node was drawn, to keep the author's order of equal branches */
  readonly y: number;
  /** whether a loop returns from this row (or a row branching off from it): it goes below, outermost */
  readonly returns?: boolean;
}

/**
 * Final row numbers relative to the entry row. Every row sits next to the row it branches off from; of several
 * branches on one side the one that rejoins soonest sits nearest, so the flows of the longer ones pass around it.
 */
export function positions(
  row: ReadonlyMap<string, number>,
  opened: readonly OpenedRow[],
  column: ReadonlyMap<string, number>,
): Map<string, number> {
  const reach = new Map<number, number>();
  row.forEach((index, id) => reach.set(index, Math.max(reach.get(index) ?? 0, column.get(id) ?? 0)));
  const span = (branch: OpenedRow): number => (reach.get(branch.id) ?? 0) - branch.from;
  const nearestFirst = (first: OpenedRow, second: OpenedRow): number => span(first) - span(second);
  const expand = (index: number): number[] => {
    const branches = opened.filter((branch) => branch.parent === index);
    const upwards = (branch: OpenedRow): boolean => branch.above && !branch.returns;
    const returnsLast = (first: OpenedRow, second: OpenedRow): number =>
      Number(first.returns ?? false) - Number(second.returns ?? false);
    const above = branches.filter(upwards).sort((first, second) => nearestFirst(second, first) || first.y - second.y);
    const below = branches
      .filter((branch) => !upwards(branch))
      .sort((first, second) => returnsLast(first, second) || nearestFirst(first, second) || first.y - second.y);
    return [...above.flatMap((branch) => expand(branch.id)), index, ...below.flatMap((branch) => expand(branch.id))];
  };
  const order = expand(0);
  const entry = order.indexOf(0);
  const position = new Map(order.map((index, place) => [index, place - entry]));
  return new Map([...row].map(([id, index]) => [id, position.get(index) ?? index]));
}

interface RowContext {
  readonly byId: ReadonlyMap<string, DiagramShape>;
  readonly skipped: ReadonlySet<string>;
  /** whether a branch from `from` into `id` opens its row above; by default where its author drew it */
  readonly above?: (id: string, from: string) => boolean;
  /** nodes a loop returns from: their rows and the rows these branch off from go below, outermost */
  readonly loops?: ReadonlySet<string>;
  /** a successor in the lane of its predecessor may continue the row when the first ones run into other lanes */
  readonly laneRows?: boolean;
}

/** Marks the rows loops return from, and the rows they branch off from, up to the root row. */
function markReturning(
  opened: readonly OpenedRow[],
  row: ReadonlyMap<string, number>,
  loops: ReadonlySet<string>,
): OpenedRow[] {
  const byId = new Map(opened.map((branch) => [branch.id, branch]));
  const returning = new Set<number>();
  for (const node of loops) {
    for (let id = row.get(node); id !== undefined && id !== 0 && !returning.has(id); id = byId.get(id)?.parent) {
      returning.add(id);
    }
  }
  return opened.map((branch) => (returning.has(branch.id) ? { ...branch, returns: true } : branch));
}

function predecessorsOf(graph: Acyclic): Map<string, string[]> {
  const predecessors = new Map<string, string[]>();
  for (const id of graph.order) {
    for (const target of graph.next.get(id) ?? []) {
      predecessors.set(target, [...(predecessors.get(target) ?? []), id]);
    }
  }
  return predecessors;
}

export interface RowTree {
  /** the row every node was put in (row ids, not yet positions) */
  readonly row: ReadonlyMap<string, number>;
  readonly opened: readonly OpenedRow[];
}

/**
 * Rows: a node continues the row of a predecessor it is the first successor of, when that cell is free; of several
 * such predecessors (a join) it takes the oldest row, the one nearest to the main path, so the main path returns to
 * its line behind every join. Otherwise, and for the flows of a boundary event, it opens a new row next to the oldest
 * row among its predecessors. The root takes row 0; `skipped` nodes get no row.
 */
interface TreeState {
  readonly graph: Acyclic;
  readonly columns: ReadonlyMap<string, number>;
  readonly context: RowContext;
  readonly predecessors: ReadonlyMap<string, readonly string[]>;
  readonly row: Map<string, number>;
  readonly taken: Set<string>;
  readonly opened: OpenedRow[];
}

function rowOf(state: TreeState, id: string): number {
  return state.row.get(id) ?? 0;
}

/** The placed predecessors of a node, the oldest row first. */
function placedPredecessors(state: TreeState, id: string): string[] {
  return (state.predecessors.get(id) ?? [])
    .filter((candidate) => state.row.has(candidate))
    .sort((first, second) => rowOf(state, first) - rowOf(state, second));
}

/**
 * The successor of `from` that continues its row: the first one — or, when the first ones run into other lanes (they
 * draw their own bands), the first one in the lane of `from`, so a branch that stays in the lane runs straight on.
 */
function continuation(state: TreeState, from: string): string | undefined {
  const next = state.graph.next.get(from) ?? [];
  const lane = state.context.byId.get(from)?.lane;
  if (!state.context.laneRows || lane === undefined) return next[0];
  return next.find((successor) => state.context.byId.get(successor)?.lane === lane) ?? next[0];
}

/** The oldest free row among the predecessors whose row the node continues. */
function continuedRow(state: TreeState, id: string, from: readonly string[]): number | undefined {
  const column = state.columns.get(id) ?? 0;
  return from
    .filter(
      (candidate) =>
        continuation(state, candidate) === id && state.context.byId.get(candidate)?.attachedTo === undefined,
    )
    .map((candidate) => rowOf(state, candidate))
    .find((candidate) => !state.taken.has(`${column}:${candidate}`));
}

/** A new row next to the row of `opener`. */
function openRow(state: TreeState, id: string, opener: string): number {
  const { byId } = state.context;
  const drawnAbove =
    state.context.above ?? ((node: string, from: string): boolean => centreY(byId, node) < centreY(byId, from));
  const above = byId.get(opener)?.attachedTo === undefined && drawnAbove(id, opener);
  const chosen = state.opened.length + 1;
  state.opened.push({
    id: chosen,
    parent: rowOf(state, opener),
    above,
    from: state.columns.get(opener) ?? 0,
    y: centreY(byId, id),
  });
  return chosen;
}

export function rowTree(
  graph: Acyclic,
  columns: ReadonlyMap<string, number>,
  root: string,
  context: RowContext,
): RowTree {
  const state: TreeState = {
    graph,
    columns,
    context,
    predecessors: predecessorsOf(graph),
    row: new Map([[root, 0]]),
    taken: new Set(["0:0"]),
    opened: [],
  };
  for (const id of graph.order) {
    const host = context.byId.get(id)?.attachedTo;
    if (state.row.has(id) || context.skipped.has(id)) {
      continue;
    }
    if (host !== undefined) {
      // a boundary event takes no cell; its flows open a new row
      state.row.set(id, rowOf(state, host));
      continue;
    }
    const from = placedPredecessors(state, id);
    const chosen = continuedRow(state, id, from) ?? openRow(state, id, from[0] ?? root);
    state.taken.add(`${columns.get(id) ?? 0}:${chosen}`);
    state.row.set(id, chosen);
  }
  return { row: state.row, opened: markReturning(state.opened, state.row, context.loops ?? new Set()) };
}

/** The row of every node relative to the root row, from the row tree. */
export function rowsOf(
  graph: Acyclic,
  columns: ReadonlyMap<string, number>,
  root: string,
  context: RowContext,
): Map<string, number> {
  const tree = rowTree(graph, columns, root, context);
  return positions(tree.row, tree.opened, columns);
}
