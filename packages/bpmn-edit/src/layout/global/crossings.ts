/**
 * Crossing reduction on the row tree: every branch may open its row above or below the row it branches off from;
 * a branch flips its side when that lowers the number of crossings, until no flip helps. The crossings are counted on
 * the grid with the route the router takes later: a flow into another row turns right behind its source (a split),
 * a flow into a gateway on another row runs along its own row and turns into the gateway (a join).
 */
import type { DiagramShape } from "../../diagram/plane.ts";
import { kindOf } from "../constants.ts";
import type { Acyclic } from "./feedback.ts";
import { type OpenedRow, positions, type RowTree } from "./rows.ts";

/** How often all branches are tried; a pass without improvement stops earlier. */
const PASSES = 3;
/** Where a flow turns, as a share of the column distance behind its source or before its target. */
const TURN = 0.3;

interface Segment {
  readonly at: number;
  readonly from: number;
  readonly to: number;
}

interface Paths {
  readonly horizontal: Segment[];
  readonly vertical: Segment[];
}

function span(at: number, first: number, second: number): Segment {
  return { at, from: Math.min(first, second), to: Math.max(first, second) };
}

interface GridView {
  readonly column: ReadonlyMap<string, number>;
  readonly row: ReadonlyMap<string, number>;
  readonly byId: ReadonlyMap<string, DiagramShape>;
}

/** The segments of one flow on the grid, none when an end is not placed or both share their column. */
function pathOf(source: string, target: string, view: GridView, paths: Paths): void {
  const { column, row, byId } = view;
  const [cs, ct, rs, rt] = [column.get(source), column.get(target), row.get(source), row.get(target)];
  if (cs === undefined || ct === undefined || rs === undefined || rt === undefined || cs === ct) {
    return;
  }
  const join = rs !== rt && kindOf(byId.get(target)?.type ?? "") === "gateway";
  const turn = join ? ct - TURN : cs + TURN;
  paths.horizontal.push(span(rs, cs, turn), span(rt, turn, ct));
  paths.vertical.push(span(turn, rs, rt));
}

function pathsOf(graph: Acyclic, view: GridView): Paths {
  const paths: Paths = { horizontal: [], vertical: [] };
  for (const [source, targets] of graph.next) {
    targets.forEach((target) => pathOf(source, target, view, paths));
  }
  return paths;
}

function crossingsOf(paths: Paths): number {
  let count = 0;
  for (const across of paths.horizontal) {
    for (const down of paths.vertical) {
      const inside = down.at > across.from && down.at < across.to && across.at > down.from && across.at < down.to;
      count += inside ? 1 : 0;
    }
  }
  return count;
}

export function reduceCrossings(
  tree: RowTree,
  graph: Acyclic,
  column: ReadonlyMap<string, number>,
  byId: ReadonlyMap<string, DiagramShape>,
): Map<string, number> {
  const evaluate = (opened: readonly OpenedRow[]): number =>
    crossingsOf(pathsOf(graph, { column, row: positions(tree.row, opened, column), byId }));
  let current = [...tree.opened];
  let best = evaluate(current);
  for (let pass = 0, improved = true; pass < PASSES && improved; pass++) {
    improved = false;
    for (const [index, branch] of current.entries()) {
      if (branch.returns) {
        continue;
      }
      const flipped = current.map((other, position) =>
        position === index ? { ...branch, above: !branch.above } : other,
      );
      const crossings = evaluate(flipped);
      if (crossings < best) {
        [current, best, improved] = [flipped, crossings, true];
      }
    }
  }
  return positions(tree.row, current, column);
}
