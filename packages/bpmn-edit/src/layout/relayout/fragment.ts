/**
 * Single-entry single-exit (SESE) fragments around a set of flow nodes, smallest first. The entries are the
 * dominators of the nodes (Cooper, Harvey, Kennedy: A Simple, Fast Dominance Algorithm); for each entry the exit is
 * the node that closes the smallest fragment in which every flow into it passes the entry and every flow out of it
 * passes the exit.
 *
 * A branch that leaves the fragment and only ends in end events (a loop that is stopped, an escalation that ends
 * the process) is a dead end: it belongs to the fragment and does not count as a way out. Otherwise one such end
 * event would widen every fragment around it to the whole plane. Dead ends are side branches: they are never
 * larger than the part of the fragment that leads to the exit, and an end event is never an exit.
 */
import { BpmnEditError } from "../../utils/errors.ts";
import { type FlowGraph, flowGraph, reversePostorder, VIRTUAL_END, VIRTUAL_START } from "./flow-graph.ts";

export interface Fragment {
  /** a flow node or VIRTUAL_START */
  readonly entry: string;
  /** a flow node or VIRTUAL_END */
  readonly exit: string;
  /** the nodes strictly between entry and exit */
  readonly interior: ReadonlySet<string>;
}

type Tree = ReadonlyMap<string, string>;

/** Immediate dominators of every node reachable from root along `next` (predecessors along `previous`). */
function dominatorTree(
  root: string,
  next: (id: string) => readonly string[],
  previous: (id: string) => readonly string[],
): Tree {
  const order = reversePostorder(root, next);
  const rank = new Map(order.map((id, index) => [id, index]));
  const idom = new Map<string, string>([[root, root]]);
  const intersect = (first: string, second: string): string => {
    let [a, b] = [first, second];
    while (a !== b) {
      while ((rank.get(a) ?? 0) > (rank.get(b) ?? 0)) {
        a = idom.get(a) ?? root;
      }
      while ((rank.get(b) ?? 0) > (rank.get(a) ?? 0)) {
        b = idom.get(b) ?? root;
      }
    }
    return a;
  };
  for (let changed = true; changed;) {
    changed = false;
    for (const id of order.slice(1)) {
      const processed = previous(id).filter((candidate) => idom.has(candidate));
      const [first, ...rest] = processed;
      const dominator = first === undefined ? undefined : rest.reduce(intersect, first);
      if (dominator !== undefined && idom.get(id) !== dominator) {
        idom.set(id, dominator);
        changed = true;
      }
    }
  }
  return idom;
}

function ancestors(tree: Tree, id: string): string[] {
  const chain = [id];
  for (let current = id; tree.get(current) !== undefined && tree.get(current) !== current;) {
    current = tree.get(current) ?? current;
    chain.push(current);
  }
  return chain;
}

/** The nearest node that dominates every id in the tree and is not one of them. */
function commonStrictAncestor(tree: Tree, ids: readonly string[]): string {
  const chains = ids.map((id) => ancestors(tree, id));
  const [first = [], ...rest] = chains;
  const common = first.find(
    (candidate) => !ids.includes(candidate) && rest.every((chain) => chain.includes(candidate)),
  );
  return common ?? first.at(-1) ?? "";
}

interface Bounds {
  readonly entry: string;
  readonly exit: string;
}

function walk(start: string, stop: string, next: (id: string) => readonly string[]): Set<string> {
  const seen = new Set<string>();
  const queue = [...next(start)];
  for (let id = queue.shift(); id !== undefined; id = queue.shift()) {
    if (id !== stop && !seen.has(id) && id !== start) {
      seen.add(id);
      queue.push(...next(id));
    }
  }
  return seen;
}

/**
 * Of the nodes that never reach the exit (and are not reached from it), those that are only entered from the
 * fragment and whose every path ends in an end event without returning.
 */
function deadEnds(graph: FlowGraph, loose: ReadonlySet<string>, core: ReadonlySet<string>): Set<string> {
  const dead = new Set([...loose].filter((id) => id !== VIRTUAL_END));
  const leaves = (id: string): boolean =>
    (graph.successors.get(id) ?? []).some((to) => to !== VIRTUAL_END && !dead.has(to));
  const enteredFromOutside = (id: string): boolean =>
    (graph.predecessors.get(id) ?? []).some((from) => !dead.has(from) && !core.has(from));
  for (let changed = true; changed;) {
    changed = false;
    for (const id of [...dead].filter((candidate) => leaves(candidate) || enteredFromOutside(candidate))) {
      dead.delete(id);
      changed = true;
    }
  }
  return dead;
}

/** The nodes between entry and exit and the dead ends that branch off from them; undefined if not a SESE fragment. */
function fragmentBetween(graph: FlowGraph, bounds: Bounds): Fragment | undefined {
  const { entry, exit } = bounds;
  const forward = walk(entry, exit, (id) => graph.successors.get(id) ?? []);
  const backward = walk(exit, entry, (id) => graph.predecessors.get(id) ?? []);
  const after = walk(exit, entry, (id) => graph.successors.get(id) ?? []);
  const core = new Set([entry, ...backward]);
  const dead = deadEnds(graph, new Set([...forward].filter((id) => !backward.has(id) && !after.has(id))), core);
  const interior = new Set([...forward].filter((id) => backward.has(id) || dead.has(id)));
  const inside = (id: string): boolean => interior.has(id);
  const closed = [...interior].every(
    (id) =>
      (graph.predecessors.get(id) ?? []).every((from) => inside(from) || from === entry) &&
      (graph.successors.get(id) ?? []).every((to) => inside(to) || to === exit || (to === VIRTUAL_END && dead.has(id))),
  );
  // the dead ends are side branches of the block, never the larger part of it
  const living = interior.size - dead.size;
  return closed && living > 0 && dead.size <= living ? { entry, exit, interior } : undefined;
}

/** A node whose only way on is the end of the plane: an end event, it cannot close a fragment. */
function isEnd(graph: FlowGraph, id: string): boolean {
  return (graph.successors.get(id) ?? []).every((to) => to === VIRTUAL_END) && id !== VIRTUAL_END;
}

/** The smallest fragment behind the entry that contains the ids. */
function smallestFrom(graph: FlowGraph, entry: string, ids: readonly string[]): Fragment | undefined {
  const exits = [...walk(entry, VIRTUAL_END, (id) => graph.successors.get(id) ?? []), VIRTUAL_END];
  return exits
    .filter((exit) => exit !== entry && !ids.includes(exit) && !isEnd(graph, exit))
    .map((exit) => fragmentBetween(graph, { entry, exit }))
    .filter((fragment): fragment is Fragment => fragment !== undefined && ids.every((id) => fragment.interior.has(id)))
    .reduce<Fragment | undefined>(
      (smallest, fragment) => (!smallest || fragment.interior.size < smallest.interior.size ? fragment : smallest),
      undefined,
    );
}

function checkIds(graph: FlowGraph, ids: readonly string[], plane: string): void {
  const unknown = ids.filter((id) => !graph.nodes.includes(id));
  if (unknown.length > 0 || ids.length === 0) {
    const named = unknown.map((id) => `'${id}'`).join(", ") || "(none given)";
    throw new BpmnEditError(`no flow node with id ${named} in plane '${plane}'`);
  }
}

/** Every fragment that contains the ids, one per entry, smallest first; the last one is the whole plane. */
export function enclosingFragments(plane: Parameters<typeof flowGraph>[0], ids: readonly string[]): Fragment[] {
  const graph = flowGraph(plane);
  checkIds(graph, ids, plane.id);
  const dominators = dominatorTree(
    VIRTUAL_START,
    (id) => graph.successors.get(id) ?? [],
    (id) => graph.predecessors.get(id) ?? [],
  );
  const fragments = ancestors(dominators, commonStrictAncestor(dominators, ids))
    .filter((entry) => entry !== VIRTUAL_START)
    .flatMap((entry) => smallestFrom(graph, entry, ids) ?? []);
  const whole = { entry: VIRTUAL_START, exit: VIRTUAL_END, interior: new Set(graph.nodes) };
  return [...fragments.sort((first, second) => first.interior.size - second.interior.size), whole];
}

/** The smallest fragment that contains the ids. */
export function findFragment(plane: Parameters<typeof flowGraph>[0], ids: readonly string[]): Fragment {
  return enclosingFragments(plane, ids)[0] ?? { entry: VIRTUAL_START, exit: VIRTUAL_END, interior: new Set() };
}
