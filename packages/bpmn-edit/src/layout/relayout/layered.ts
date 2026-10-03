/**
 * Layered layout of the interior of a fragment, left to right from its entry: the loops are cut (global/feedback.ts),
 * columns come from the longest path (global/columns.ts), rows from the row tree (global/rows.ts).
 */
import type { DiagramPlane, DiagramShape } from "../../diagram/plane.ts";
import type { Point } from "../../geometry/geometry.ts";
import { columnsOf } from "../global/columns.ts";
import { acyclic } from "../global/feedback.ts";
import { rowsOf } from "../global/rows.ts";
import { center, shapesById } from "../space.ts";
import { flowGraph } from "./flow-graph.ts";
import type { Fragment } from "./fragment.ts";
import type { Spacing } from "./spacing.ts";

export interface Placement {
  /** new centre of every interior node; boundary events are not placed, they follow their host */
  readonly centres: ReadonlyMap<string, Point>;
  /** where the exit would sit with its left edge */
  readonly exitX: number;
}

/** New centres of the interior nodes: columns from the entry to the right, rows from the entry row downwards. */
export function placeInterior(plane: DiagramPlane, fragment: Fragment, origin: Point, spacing: Spacing): Placement {
  const byId = shapesById(plane);
  const graph = flowGraph(plane);
  const members = new Set([fragment.entry, ...fragment.interior, fragment.exit]);
  const forward = acyclic(
    fragment.entry,
    (id) => graph.successors.get(id) ?? [],
    (id) => members.has(id),
    byId,
  );
  const columnOf = columnsOf(forward, fragment.entry, byId);
  const row = rowsOf(forward, columnOf, fragment.entry, { byId, skipped: new Set([fragment.exit]) });
  const nodes = [...fragment.interior].filter((id) => !byId.get(id)?.attachedTo);
  const columns = Math.max(...nodes.map((id) => columnOf.get(id) ?? 0), 0);
  const width = (column: number): number =>
    Math.max(0, ...nodes.filter((id) => columnOf.get(id) === column).map((id) => byId.get(id)?.bounds.width ?? 0));
  const centreX: number[] = [];
  let right = origin.x;
  for (let column = 1; column <= columns; column++) {
    centreX[column] = right + spacing.columnGap + width(column) / 2;
    right = (centreX[column] ?? right) + width(column) / 2;
  }
  const centres = new Map(
    nodes.map((id) => [
      id,
      { x: centreX[columnOf.get(id) ?? 1] ?? right, y: origin.y + (row.get(id) ?? 0) * spacing.rowSpacing },
    ]),
  );
  return { centres, exitX: right + spacing.columnGap };
}

/** The origin of a fragment: the right edge and the centre line of its entry shape. */
export function originOf(entry: DiagramShape): Point {
  return { x: entry.bounds.x + entry.bounds.width, y: center(entry.bounds).y };
}
