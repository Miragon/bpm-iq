/**
 * Columns (Sugiyama, step two): the longest path from the root, so every forward flow ends at least one column
 * further right and a node stands as far left as its predecessors allow (the task right behind its split, the long
 * flow runs into the join). A boundary event shares the column of its host.
 */
import type { DiagramShape } from "../../diagram/plane.ts";
import type { Acyclic } from "./feedback.ts";

export function columnsOf(graph: Acyclic, root: string, byId: ReadonlyMap<string, DiagramShape>): Map<string, number> {
  const column = new Map<string, number>([[root, 0]]);
  for (const id of graph.order) {
    const own = column.get(id) ?? 0;
    for (const target of graph.next.get(id) ?? []) {
      const step = byId.get(target)?.attachedTo === id ? 0 : 1;
      column.set(target, Math.max(column.get(target) ?? 0, own + step));
    }
  }
  return column;
}
