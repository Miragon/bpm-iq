/**
 * The flow graph of one plane: flow nodes and sequence flows, a boundary event as successor of its host, and a
 * virtual start and end so that every node is reachable from one root and reaches one sink.
 */
import type { DiagramPlane } from "../../diagram/plane.ts";

export const VIRTUAL_START = "#start";
export const VIRTUAL_END = "#end";

export interface FlowGraph {
  /** real flow nodes in plane order */
  readonly nodes: readonly string[];
  readonly successors: ReadonlyMap<string, readonly string[]>;
  readonly predecessors: ReadonlyMap<string, readonly string[]>;
}

function add(map: Map<string, string[]>, from: string, to: string): void {
  const list = map.get(from) ?? [];
  if (!list.includes(to)) {
    list.push(to);
  }
  map.set(from, list);
}

export function flowGraph(plane: DiagramPlane): FlowGraph {
  const successors = new Map<string, string[]>();
  const predecessors = new Map<string, string[]>();
  const link = (from: string, to: string): void => {
    add(successors, from, to);
    add(predecessors, to, from);
  };
  for (const edge of plane.edges) {
    if (edge.type === "SequenceFlow" && edge.source && edge.target) {
      link(edge.source, edge.target);
    }
  }
  for (const shape of plane.shapes) {
    if (shape.attachedTo) {
      link(shape.attachedTo, shape.id);
    }
  }
  const nodes = plane.shapes.map((shape) => shape.id).filter((id) => successors.has(id) || predecessors.has(id));
  for (const id of nodes) {
    if (!predecessors.has(id)) {
      link(VIRTUAL_START, id);
    }
    if (!successors.has(id)) {
      link(id, VIRTUAL_END);
    }
  }
  return { nodes, successors, predecessors };
}

/** Nodes in reverse postorder of a depth-first search from `root` along `next`. */
export function reversePostorder(root: string, next: (id: string) => readonly string[]): string[] {
  const order: string[] = [];
  const seen = new Set<string>([root]);
  const stack: [string, number][] = [[root, 0]];
  while (stack.length > 0) {
    const top = stack.at(-1);
    if (!top) {
      break;
    }
    const [id, index] = top;
    const child = next(id)[index];
    if (child === undefined) {
      stack.pop();
      order.push(id);
      continue;
    }
    top[1] = index + 1;
    if (!seen.has(child)) {
      seen.add(child);
      stack.push([child, 0]);
    }
  }
  return order.reverse();
}
