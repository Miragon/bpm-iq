/** Limits a process outline to the neighbourhood of one element: the view an agent needs for a local change. */
import type { ProcessOutline } from "./types.ts";

function link(adjacency: Map<string, Set<string>>, first: string, second: string): void {
  adjacency.set(first, (adjacency.get(first) ?? new Set()).add(second));
  adjacency.set(second, (adjacency.get(second) ?? new Set()).add(first));
}

/** Neighbours along sequence flows in both directions; a boundary event and its host count as neighbours. */
function adjacencyOf(process: ProcessOutline): Map<string, Set<string>> {
  const adjacency = new Map<string, Set<string>>();
  for (const flow of process.flows) {
    link(adjacency, flow.from, flow.to);
  }
  for (const element of process.elements) {
    if (element.attachedTo) {
      link(adjacency, element.id, element.attachedTo);
    }
  }
  return adjacency;
}

function reachable(adjacency: ReadonlyMap<string, ReadonlySet<string>>, start: string, depth: number): Set<string> {
  const seen = new Set([start]);
  let frontier = [start];
  for (let step = 0; step < depth && frontier.length > 0; step++) {
    const next = frontier.flatMap((id) => [...(adjacency.get(id) ?? [])]).filter((id) => !seen.has(id));
    next.forEach((id) => seen.add(id));
    frontier = next;
  }
  return seen;
}

/** The part of the process within `depth` flow steps of `around`; undefined when the process has no such element. */
export function limitToWindow(process: ProcessOutline, around: string, depth: number): ProcessOutline | undefined {
  if (!process.elements.some((element) => element.id === around)) {
    return undefined;
  }
  const kept = reachable(adjacencyOf(process), around, depth);
  const elements = process.elements.filter((element) => kept.has(element.id));
  const flows = process.flows.filter((flow) => kept.has(flow.from) && kept.has(flow.to));
  return {
    ...process,
    elements,
    flows,
    omitted: { elements: process.elements.length - elements.length, flows: process.flows.length - flows.length },
  };
}
