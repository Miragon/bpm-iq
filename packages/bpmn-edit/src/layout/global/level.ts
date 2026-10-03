/**
 * The grid of one level (a plane, a pool or an expanded sub-process): the column and the row of every flow node.
 * All nodes without a predecessor on the level hang below one virtual root, start events first; a loop without any
 * way in joins them through its leftmost node. The end events share the last column (one column on the right). The
 * successor with the longest way ahead continues the row, so the main path runs straight; every other branch opens
 * its row below, or above where that saves crossings (the current drawing does not decide, it is what gets replaced).
 */
import type { DiagramEdge, DiagramPlane, DiagramShape } from "../../diagram/plane.ts";
import { kindOf, LABEL_CLEARANCE, LABEL_DISTANCE, ROUTE_MARGIN } from "../constants.ts";
import { labelSize } from "../label-size.ts";
import { flowGraph } from "../relayout/flow-graph.ts";
import { shapesById } from "../space.ts";
import { columnsOf } from "./columns.ts";
import { reduceCrossings } from "./crossings.ts";
import { type Acyclic, acyclic } from "./feedback.ts";
import { rowTree } from "./rows.ts";

const ROOT = "#level";

export interface Grid {
  /** column of every flow node of the level, from 0; none for a node without any flow (an event sub-process) */
  readonly column: ReadonlyMap<string, number>;
  /** row of every flow node in the row tree of the level; boundary events share the row of their host */
  readonly row: ReadonlyMap<string, number>;
  /** the free space a column needs before it, beyond the column gap, for the labels of the flows coming in */
  readonly room: ReadonlyMap<number, number>;
}

function sourcesOf(members: readonly DiagramShape[], predecessors: ReadonlyMap<string, readonly string[]>): string[] {
  const ids = new Set(members.map((shape) => shape.id));
  const start = (shape: DiagramShape): number => (shape.type === "StartEvent" ? 0 : 1);
  return members
    .filter((shape) => !shape.attachedTo && !(predecessors.get(shape.id) ?? []).some((id) => ids.has(id)))
    .sort((first, second) => start(first) - start(second) || first.bounds.y - second.bounds.y)
    .map((shape) => shape.id);
}

/** The acyclic flow of the level; nodes the root does not reach (a loop without a way in) become sources too. */
function forwardFlow(plane: DiagramPlane, members: readonly DiagramShape[]): Acyclic {
  const graph = flowGraph(plane);
  const byId = shapesById(plane);
  const ids = new Set(members.map((shape) => shape.id));
  const sources = sourcesOf(members, graph.predecessors);
  const successors = (id: string): readonly string[] => (id === ROOT ? sources : (graph.successors.get(id) ?? []));
  for (;;) {
    const forward = acyclic(ROOT, successors, (id) => ids.has(id), byId);
    const reached = new Set(forward.order);
    const missing = members.filter((shape) => !shape.attachedTo && !reached.has(shape.id));
    const leftmost = [...missing].sort((first, second) => first.bounds.x - second.bounds.x)[0];
    if (!leftmost) {
      return forward;
    }
    sources.push(leftmost.id);
  }
}

/** The number of columns every node still has ahead of it along forward flows. */
function wayAhead(graph: Acyclic): Map<string, number> {
  const ahead = new Map<string, number>();
  for (const id of [...graph.order].reverse()) {
    ahead.set(id, Math.max(0, ...(graph.next.get(id) ?? []).map((target) => (ahead.get(target) ?? 0) + 1)));
  }
  return ahead;
}

/** The loop sources every node reaches along forward flows, itself included. */
function loopsAhead(graph: Acyclic, loops: ReadonlySet<string>): Map<string, Set<string>> {
  const reach = new Map<string, Set<string>>();
  for (const id of [...graph.order].reverse()) {
    const own = new Set(loops.has(id) ? [id] : []);
    (graph.next.get(id) ?? []).forEach((target) => reach.get(target)?.forEach((source) => own.add(source)));
    reach.set(id, own);
  }
  return reach;
}

/**
 * The successors in the order of the rows: the flows of boundary events last; a branch that leads to a loop return
 * none of its siblings reaches never continues the row (it goes below, where its return runs); else the longest way
 * ahead first.
 */
function mainPathFirst(graph: Acyclic, byId: ReadonlyMap<string, DiagramShape>, loops: ReadonlySet<string>): Acyclic {
  const ahead = wayAhead(graph);
  const reach = loopsAhead(graph, loops);
  const boundary = (id: string): number => (byId.get(id)?.attachedTo === undefined ? 0 : 1);
  const returning = (target: string, siblings: readonly string[]): number => {
    const others = new Set(
      siblings.filter((sibling) => sibling !== target).flatMap((sibling) => [...(reach.get(sibling) ?? [])]),
    );
    return [...(reach.get(target) ?? [])].some((source) => !others.has(source)) && siblings.length > 1 ? 1 : 0;
  };
  const next = new Map(
    [...graph.next].map(([id, targets]) => [
      id,
      [...targets].sort(
        (first, second) =>
          boundary(first) - boundary(second) ||
          returning(first, targets) - returning(second, targets) ||
          (ahead.get(second) ?? 0) - (ahead.get(first) ?? 0),
      ),
    ]),
  );
  return { order: graph.order, next };
}

/** Nodes of the level without any sequence flow to or from another node of the level, boundary flows included. */
function isolatedOf(plane: DiagramPlane, members: readonly DiagramShape[]): Set<string> {
  const graph = flowGraph(plane);
  const ids = new Set(members.map((shape) => shape.id));
  const attached = new Set(members.flatMap((shape) => (shape.attachedTo ? [shape.attachedTo] : [])));
  const linked = (id: string): boolean =>
    [...(graph.successors.get(id) ?? []), ...(graph.predecessors.get(id) ?? [])].some((other) => ids.has(other));
  return new Set(
    members
      .filter((shape) => !shape.attachedTo && !attached.has(shape.id) && !linked(shape.id))
      .map((shape) => shape.id),
  );
}

/** Nodes of the level with a flow back to a node before them: the loop returns start there. */
function loopSources(plane: DiagramPlane, members: readonly DiagramShape[], forward: Acyclic): Set<string> {
  const graph = flowGraph(plane);
  const ids = new Set(members.map((shape) => shape.id));
  return new Set(
    members
      .filter((shape) =>
        (graph.successors.get(shape.id) ?? []).some(
          (target) => ids.has(target) && !(forward.next.get(shape.id) ?? []).includes(target),
        ),
      )
      .map((shape) => shape.attachedTo ?? shape.id),
  );
}

export function gridOf(plane: DiagramPlane, all: readonly DiagramShape[], laneRows = false): Grid {
  const byId = shapesById(plane);
  const isolated = isolatedOf(plane, all);
  const members = all.filter((shape) => !isolated.has(shape.id));
  const acyclicFlow = forwardFlow(plane, members);
  const loops = loopSources(plane, members, acyclicFlow);
  const forward = mainPathFirst(acyclicFlow, byId, loops);
  const column = columnsOf(forward, ROOT, byId);
  const nodes = members.filter((shape) => !shape.attachedTo);
  const last = Math.max(0, ...nodes.map((shape) => column.get(shape.id) ?? 0));
  nodes.filter((shape) => shape.type === "EndEvent").forEach((shape) => column.set(shape.id, last));
  const tree = rowTree(forward, column, ROOT, {
    byId,
    skipped: new Set(),
    above: () => false,
    loops,
    laneRows,
  });
  const row = reduceCrossings(tree, forward, column, byId);
  // the root took column 0
  const shifted = new Map([...column].filter(([id]) => id !== ROOT).map(([id, index]) => [id, index - 1] as const));
  return { column: shifted, row, room: labelRoom(plane, byId, shifted) };
}

/**
 * The space the label of a flow into the next column needs between the two columns: its width on at most two lines,
 * its distance and clearance on both sides, and the stub a branch leaves its gateway by before it forks.
 */
function labelRoom(
  plane: DiagramPlane,
  byId: ReadonlyMap<string, DiagramShape>,
  column: ReadonlyMap<string, number>,
): Map<number, number> {
  const room = new Map<number, number>();
  for (const edge of plane.edges) {
    const needed = neededRoom(edge, byId, column);
    if (needed) {
      room.set(needed.column, Math.max(room.get(needed.column) ?? 0, needed.width));
    }
  }
  return room;
}

/** Lines the label of a flow may take where its line is short: the room is made for these. */
const LABEL_ROOM_LINES = 2;

/** The room the label of `edge` needs before the column of its target, when that column follows its source. */
function neededRoom(
  edge: DiagramEdge,
  byId: ReadonlyMap<string, DiagramShape>,
  column: ReadonlyMap<string, number>,
): { readonly column: number; readonly width: number } | undefined {
  const source = byId.get(edge.source ?? "");
  if (!edge.name || !edge.label || !source) {
    return undefined;
  }
  const [from, to] = [column.get(source.attachedTo ?? source.id), column.get(edge.target ?? "")];
  if (from === undefined || to !== from + 1) {
    return undefined;
  }
  const stub = kindOf(source.type) === "gateway" ? ROUTE_MARGIN : 0;
  return {
    column: to,
    width: labelSize(edge.name, LABEL_ROOM_LINES).width + 2 * (LABEL_DISTANCE + LABEL_CLEARANCE) + stub,
  };
}
