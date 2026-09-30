/**
 * Lanes are roles: bpmiq derives a process's roles from them, so every flow node of a process with lanes belongs to
 * one (`flowNodeRef`). A new node joins the lane of its anchor unless another is named, a removed node leaves its lane,
 * and moveToLane changes the role of a node together with its boundary events.
 */
import type { ModdleElement } from "bpmn-moddle";

import type { BpmnDocument } from "../model/document.ts";
import { BpmnEditError } from "../utils/errors.ts";
import { diOf } from "./di.ts";

/** height of a lane band added to a pool (a hand-made lane of one row) */
const NEW_LANE_HEIGHT = 150;
/** the header strip of a pool left of its lanes (bpmn-js) */
const POOL_HEADER = 30;

/** Every lane of the process, nested ones after their parent. */
export function lanesOf(process: ModdleElement): ModdleElement[] {
  const walk = (laneSet: ModdleElement | undefined): ModdleElement[] =>
    (laneSet?.lanes ?? []).flatMap((lane) => [lane, ...walk(lane.childLaneSet)]);
  return (process.laneSets ?? []).flatMap(walk);
}

/** The process (not sub-process) a lane assignment happens in: lanes reference the nodes at process level only. */
function laneProcessOf(node: ModdleElement): ModdleElement | undefined {
  const parent = node.$parent;
  return parent?.$type === "bpmn:Process" ? parent : undefined;
}

/** The innermost lane that references the node. */
export function laneOf(node: ModdleElement): ModdleElement | undefined {
  const process = laneProcessOf(node);
  if (!process) {
    return undefined;
  }
  const lanes = lanesOf(process).filter((lane) => (lane.flowNodeRef ?? []).includes(node));
  return lanes.at(-1);
}

/** Removes the node from every lane that references it. */
export function leaveLanes(node: ModdleElement): void {
  const process = laneProcessOf(node);
  for (const lane of process ? lanesOf(process) : []) {
    const refs = lane.flowNodeRef ?? [];
    const index = refs.indexOf(node);
    if (index !== -1) {
      refs.splice(index, 1);
    }
  }
}

/** The lane with the id in the node's process; an error names the lanes there are. */
export function laneById(node: ModdleElement, id: string): ModdleElement {
  const process = laneProcessOf(node);
  const lanes = process ? lanesOf(process) : [];
  const lane = lanes.find((candidate) => candidate.id === id);
  if (!lane) {
    const known = lanes.map((candidate) => candidate.id ?? "").join(", ");
    throw new BpmnEditError(
      known
        ? `no lane '${id}' in the process of '${node.id ?? ""}' (lanes: ${known})`
        : `'${node.id ?? ""}' is in a process without lanes`,
    );
  }
  if ((lane.childLaneSet?.lanes ?? []).length > 0) {
    throw new BpmnEditError(`lane '${id}' has nested lanes; name one of them`);
  }
  return lane;
}

/** Puts the node into the lane (and out of any other). */
export function joinLane(node: ModdleElement, lane: ModdleElement): void {
  leaveLanes(node);
  (lane.flowNodeRef ??= []).push(node);
}

/**
 * The lane a new node joins: the named one, else its anchor's; none in a process without lanes or inside a
 * sub-process.
 */
export function assignLane(node: ModdleElement, anchor: ModdleElement, named: string | undefined): void {
  if (named !== undefined) {
    joinLane(node, laneById(node, named));
    return;
  }
  const lane = laneOf(anchor) ?? (anchor.attachedToRef ? laneOf(anchor.attachedToRef) : undefined);
  if (lane && laneProcessOf(node)) {
    joinLane(node, lane);
  }
}

/**
 * A new lane (role) at the bottom of the process's pool. The first lane of a process takes every flow node there is
 * and fills the pool; every further one is a band below the others, and the pool grows by it. The layout (mode
 * 'layout') then arranges the nodes into their bands.
 */
export function addLane(document: BpmnDocument, process: ModdleElement, id: string, name: string): ModdleElement {
  const participant = (document.definitions.rootElements ?? [])
    .flatMap((root) => root.participants ?? [])
    .find((candidate) => candidate.processRef === process);
  const pool = participant ? diOf(document, participant) : undefined;
  if (!pool?.bounds) {
    throw new BpmnEditError(`the process '${process.id ?? ""}' is drawn without a pool; lanes need one`);
  }
  const laneSet = laneSetOf(document, process);
  const existing = laneSet.lanes ?? [];
  const lane = document.moddle.create("bpmn:Lane", { id, name });
  lane.$parent = laneSet;
  if (existing.length === 0) {
    lane.flowNodeRef = (process.flowElements ?? []).filter(isFlowNode);
  }
  laneSet.lanes = [...existing, lane];
  drawLane(document, pool, lane, existing);
  return lane;
}

function isFlowNode(element: ModdleElement): boolean {
  return (
    element.$type !== "bpmn:SequenceFlow" &&
    !element.$type.endsWith("Object") &&
    element.$type !== "bpmn:DataStoreReference"
  );
}

/** The lane set of the process, created when it has none. */
function laneSetOf(document: BpmnDocument, process: ModdleElement): ModdleElement {
  const existing = process.laneSets?.[0];
  if (existing) return existing;
  const laneSet = document.moddle.create("bpmn:LaneSet", { id: `LaneSet_${process.id ?? "1"}` });
  laneSet.$parent = process;
  process.laneSets = [laneSet];
  return laneSet;
}

/** The lane's band: the whole pool for the first lane, else below the others, the pool growing by it. */
function drawLane(
  document: BpmnDocument,
  pool: ModdleElement,
  lane: ModdleElement,
  others: readonly ModdleElement[],
): void {
  const { moddle } = document;
  const { x, y, width, height } = pool.bounds!;
  const otherShapes = others.flatMap((other) => diOf(document, other) ?? []);
  const top = others.length === 0 ? y : Math.max(y, ...otherShapes.map((di) => di.bounds!.y + di.bounds!.height));
  const laneHeight = others.length === 0 ? height : NEW_LANE_HEIGHT;
  const shape = moddle.create("bpmndi:BPMNShape", { id: `${lane.id ?? ""}_di`, bpmnElement: lane, isHorizontal: true });
  shape.bounds = moddle.create("dc:Bounds", {
    x: x + POOL_HEADER,
    y: top,
    width: width - POOL_HEADER,
    height: laneHeight,
  });
  const plane = pool.$parent;
  if (plane) {
    shape.$parent = plane;
    // lanes are drawn right after their pool and the lanes before them, as bpmn-js writes them
    const elements = (plane.planeElement ??= []);
    const after = Math.max(elements.indexOf(pool), ...otherShapes.map((di) => elements.indexOf(di)));
    elements.splice(after + 1, 0, shape);
  }
  if (top + laneHeight > y + height) {
    pool.bounds = moddle.create("dc:Bounds", { x, y, width, height: top + laneHeight - y });
  }
}
