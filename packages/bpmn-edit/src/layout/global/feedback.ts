/**
 * The flow without its loops (Sugiyama, step one): a depth-first search from the root in the order the flows are
 * drawn; a flow back to a node the search has already placed before (reverse postorder) is a loop return. Only these
 * may run right to left; every other flow becomes a forward edge of the acyclic graph the columns are built on.
 */
import type { DiagramShape } from "../../diagram/plane.ts";
import { reversePostorder } from "../relayout/flow-graph.ts";
import { center } from "../space.ts";

export interface Acyclic {
  /** the nodes in reverse postorder from the root: a topological order of the forward flows */
  readonly order: readonly string[];
  /** forward successors of every node: the one drawn on the same line first, the flows of boundary events last */
  readonly next: ReadonlyMap<string, readonly string[]>;
}

export function centreY(byId: ReadonlyMap<string, DiagramShape>, id: string): number {
  const shape = byId.get(id);
  return shape ? center(shape.bounds).y : 0;
}

export function acyclic(
  root: string,
  successors: (id: string) => readonly string[],
  inside: (id: string) => boolean,
  byId: ReadonlyMap<string, DiagramShape>,
): Acyclic {
  const order = reversePostorder(root, (id) => successors(id).filter(inside));
  const rank = new Map(order.map((id, index) => [id, index]));
  const y = (id: string): number => byId.get(id)?.bounds.y ?? 0;
  const boundary = (id: string): number => (byId.get(id)?.attachedTo === undefined ? 0 : 1);
  const next = new Map<string, string[]>();
  for (const id of order) {
    const line = centreY(byId, id);
    const targets = successors(id)
      .filter((target) => inside(target) && (rank.get(target) ?? 0) > (rank.get(id) ?? 0))
      .sort(
        (first, second) =>
          boundary(first) - boundary(second) ||
          Math.abs(centreY(byId, first) - line) - Math.abs(centreY(byId, second) - line) ||
          y(first) - y(second),
      );
    next.set(id, targets);
  }
  return { order, next };
}
