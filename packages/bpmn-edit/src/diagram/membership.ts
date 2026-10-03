/**
 * Which pool, lane and sub-process a flow node belongs to, from the semantic model: a participant holds the flow
 * nodes of its process (sub-process children included), a lane the nodes it references (the innermost of nested lanes
 * wins), a sub-process its children. Lanes themselves belong to the pool of their process and to the lane they are
 * nested in.
 */
import type { ModdleElement } from "bpmn-moddle";

export interface Membership {
  readonly lane?: string;
  readonly pool?: string;
  /** the sub-process (or transaction) that holds the node directly */
  readonly parent?: string;
}

/** Every flow node below the container with the sub-process that holds it directly (none at process level). */
function flowNodesOf(container: ModdleElement, parent?: string): [ModdleElement, string | undefined][] {
  return (container.flowElements ?? []).flatMap((element): [ModdleElement, string | undefined][] => [
    [element, parent],
    ...flowNodesOf(element, element.id),
  ]);
}

function lanesOf(
  laneSet: ModdleElement | undefined,
  parent: string | undefined,
): [ModdleElement, string | undefined][] {
  return (laneSet?.lanes ?? []).flatMap((lane) => [[lane, parent], ...lanesOf(lane.childLaneSet, lane.id)]);
}

/** The lane of every referenced flow node; outer lanes come first, so the innermost lane that references it wins. */
function laneIndex(lanes: readonly [ModdleElement, string | undefined][]): Map<string, string> {
  const laneOf = new Map<string, string>();
  for (const [lane] of lanes) {
    for (const node of lane.flowNodeRef ?? []) {
      if (node.id && lane.id) {
        laneOf.set(node.id, lane.id);
      }
    }
  }
  return laneOf;
}

function addProcess(members: Map<string, Membership>, process: ModdleElement, pool: string | undefined): void {
  const lanes = (process.laneSets ?? []).flatMap((laneSet) => lanesOf(laneSet, undefined));
  const laneOf = laneIndex(lanes);
  // a boundary event not referenced by a lane lies in the lane of its host
  const laneOfNode = (node: ModdleElement): string | undefined =>
    laneOf.get(node.id ?? "") ?? laneOf.get(node.attachedToRef?.id ?? "");
  for (const [node, parent] of flowNodesOf(process)) {
    if (node.id) {
      members.set(node.id, { pool, lane: laneOfNode(node), parent });
    }
  }
  for (const [lane, parent] of lanes) {
    if (lane.id) {
      members.set(lane.id, { pool, lane: parent });
    }
  }
}

export function membershipOf(definitions: ModdleElement): Map<string, Membership> {
  const members = new Map<string, Membership>();
  const roots = definitions.rootElements ?? [];
  const participants = roots.flatMap((root) => root.participants ?? []);
  const pooled = new Set<ModdleElement>();
  for (const participant of participants) {
    if (participant.processRef) {
      pooled.add(participant.processRef);
      addProcess(members, participant.processRef, participant.id);
    }
  }
  for (const process of roots.filter((root) => root.$type === "bpmn:Process" && !pooled.has(root))) {
    addProcess(members, process, undefined);
  }
  return members;
}
