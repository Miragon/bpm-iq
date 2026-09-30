/** Reads the DI planes of a BPMN document through bpmn-moddle, the object model of the modeler. */
import type { ModdleBounds, ModdleElement } from "bpmn-moddle";

import type { Rect } from "../geometry/geometry.ts";
import { parseDocument } from "../model/document.ts";
import { type Membership, membershipOf } from "./membership.ts";
import type { DiagramEdge, DiagramPlane, DiagramShape } from "./plane.ts";

const CONTAINER_TYPES: ReadonlySet<string> = new Set(["Participant", "Lane", "Group"]);
const SHAPE = "bpmndi:BPMNShape";
const EDGE = "bpmndi:BPMNEdge";

function localType(element: ModdleElement): string {
  return element.$type.slice(element.$type.indexOf(":") + 1);
}

function toRect(bounds: ModdleBounds | undefined): Rect | undefined {
  return bounds ? { x: bounds.x, y: bounds.y, width: bounds.width, height: bounds.height } : undefined;
}

/**
 * The external label and its text, only when the element has a name to show and the DI places it explicitly; none
 * of both otherwise.
 */
function labelOf(di: ModdleElement, semantic: ModdleElement): { label: Rect; name: string } | Record<string, never> {
  const name = semantic.name?.trim();
  const label = name ? toRect(di.label?.bounds) : undefined;
  return name && label ? { label, name } : {};
}

function toShape(
  di: ModdleElement,
  semantic: ModdleElement,
  id: string,
  member?: Membership,
): DiagramShape | undefined {
  const bounds = toRect(di.bounds);
  if (!bounds) {
    return undefined;
  }
  const type = localType(semantic);
  const expandedSubProcess = type.endsWith("SubProcess") && di.isExpanded === true;
  return {
    id,
    type,
    bounds,
    ...labelOf(di, semantic),
    attachedTo: semantic.attachedToRef?.id,
    container: CONTAINER_TYPES.has(type) || expandedSubProcess,
    ...(member?.lane ? { lane: member.lane } : {}),
    ...(member?.pool ? { pool: member.pool } : {}),
  };
}

function toEdge(di: ModdleElement, semantic: ModdleElement, id: string): DiagramEdge {
  return {
    id,
    type: localType(semantic),
    source: semantic.sourceRef?.id,
    target: semantic.targetRef?.id,
    waypoints: (di.waypoint ?? []).map((point) => ({ x: point.x, y: point.y })),
    ...labelOf(di, semantic),
  };
}

interface Collector {
  readonly shapes: DiagramShape[];
  readonly edges: DiagramEdge[];
  readonly members: ReadonlyMap<string, Membership>;
}

/** Adds one DI element to the shapes or edges of its plane; DI without a resolvable semantic element is skipped. */
function collect(di: ModdleElement, collector: Collector): void {
  const { shapes, edges } = collector;
  const semantic = di.bpmnElement;
  const id = semantic?.id;
  if (!semantic || !id) {
    return;
  }
  if (di.$type === EDGE) {
    edges.push(toEdge(di, semantic, id));
    return;
  }
  const shape = di.$type === SHAPE ? toShape(di, semantic, id, collector.members.get(id)) : undefined;
  if (shape) {
    shapes.push(shape);
  }
}

function toPlane(diagram: ModdleElement, index: number, members: ReadonlyMap<string, Membership>): DiagramPlane {
  const plane = diagram.plane;
  const collector: Collector = { shapes: [], edges: [], members };
  for (const di of plane?.planeElement ?? []) {
    collect(di, collector);
  }
  // a parent counts only when it is drawn expanded on this plane; the children of a collapsed one have their own plane
  const frames = new Set(collector.shapes.filter((shape) => shape.container).map((shape) => shape.id));
  const shapes = collector.shapes.map((shape) => {
    const parent = members.get(shape.id)?.parent;
    return parent && frames.has(parent) ? { ...shape, parent } : shape;
  });
  return { id: plane?.bpmnElement?.id ?? `plane-${index + 1}`, shapes, edges: collector.edges };
}

/** Every diagram plane of the definitions: the process (or collaboration) and one per collapsed sub-process. */
export function planesOf(definitions: ModdleElement): DiagramPlane[] {
  const members = membershipOf(definitions);
  return (definitions.diagrams ?? []).map((diagram, index) => toPlane(diagram, index, members));
}

export async function readPlanes(xml: string, source: string): Promise<DiagramPlane[]> {
  return planesOf((await parseDocument(xml, source)).definitions);
}
