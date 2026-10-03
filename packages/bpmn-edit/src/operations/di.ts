/**
 * DI of created and removed elements. A created element first gets provisional geometry next to its anchor; the
 * geometry step then places it, makes room and routes its flows.
 */
import type { ModdleElement } from "bpmn-moddle";

import type { Point, Rect } from "../geometry/geometry.ts";
import { kindOf, LABEL_CHAR_WIDTH, LABEL_LINE_HEIGHT, SIZES } from "../layout/constants.ts";
import type { BpmnDocument } from "../model/document.ts";
import { BpmnEditError } from "../utils/errors.ts";

const LABEL_MAX_WIDTH = 90;
const LABEL_MIN_WIDTH = 20;

function planes(document: BpmnDocument): ModdleElement[] {
  return (document.definitions.diagrams ?? []).flatMap((diagram) => (diagram.plane ? [diagram.plane] : []));
}

export function diOf(document: BpmnDocument, element: ModdleElement): ModdleElement | undefined {
  return planes(document)
    .flatMap((plane) => plane.planeElement ?? [])
    .find((di) => di.bpmnElement === element);
}

/** The DI plane that shows the given element. */
export function planeShowing(document: BpmnDocument, element: ModdleElement): ModdleElement {
  const plane = planes(document).find((candidate) =>
    (candidate.planeElement ?? []).some((di) => di.bpmnElement === element),
  );
  if (!plane) {
    throw new BpmnEditError(`'${element.id ?? ""}' has no shape in any diagram`);
  }
  return plane;
}

/** The size of the element type of layout-geometry.md. */
export function sizeOf(element: ModdleElement): { width: number; height: number } {
  return SIZES[kindOf(element.$type.slice(element.$type.indexOf(":") + 1))];
}

/** Estimated bounds of an external label with the given text below `anchor` (centre of the owner). */
export function labelBounds(text: string, anchor: Point): Rect {
  const width = Math.min(LABEL_MAX_WIDTH, Math.max(LABEL_MIN_WIDTH, text.length * LABEL_CHAR_WIDTH));
  const lines = Math.ceil((text.length * LABEL_CHAR_WIDTH) / LABEL_MAX_WIDTH) || 1;
  return { x: anchor.x - width / 2, y: anchor.y, width, height: lines * LABEL_LINE_HEIGHT };
}

function label(document: BpmnDocument, bounds: Rect): ModdleElement {
  const { moddle } = document;
  const created = moddle.create("bpmndi:BPMNLabel");
  created.bounds = moddle.create("dc:Bounds", bounds);
  return created;
}

/**
 * The DI id for a new element in the convention the plane already uses: `Shape_<id>` / `Edge_<id>` (Camunda
 * Modeler) or `<id>_di` (bpmn-js, the default).
 */
function diId(plane: ModdleElement, element: ModdleElement, kind: "Shape" | "Edge"): string {
  const id = element.id ?? "";
  const modelerStyle = (plane.planeElement ?? []).some(
    (di) =>
      di.bpmnElement?.id !== undefined &&
      (di.id === `Shape_${di.bpmnElement.id}` || di.id === `Edge_${di.bpmnElement.id}`),
  );
  return modelerStyle ? `${kind}_${id}` : `${id}_di`;
}

export function addShape(document: BpmnDocument, plane: ModdleElement, element: ModdleElement, bounds: Rect): void {
  const { moddle } = document;
  const shape = moddle.create("bpmndi:BPMNShape", { id: diId(plane, element, "Shape"), bpmnElement: element });
  shape.bounds = moddle.create("dc:Bounds", bounds);
  const kind = kindOf(element.$type.slice(element.$type.indexOf(":") + 1));
  if (element.name && (kind === "event" || kind === "gateway")) {
    shape.label = label(
      document,
      labelBounds(element.name, {
        x: bounds.x + bounds.width / 2,
        y: bounds.y + bounds.height + LABEL_LINE_HEIGHT / 2,
      }),
    );
  }
  shape.$parent = plane;
  (plane.planeElement ??= []).push(shape);
}

export function addEdge(
  document: BpmnDocument,
  plane: ModdleElement,
  flow: ModdleElement,
  waypoints: readonly Point[],
): void {
  const { moddle } = document;
  const edge = moddle.create("bpmndi:BPMNEdge", { id: diId(plane, flow, "Edge"), bpmnElement: flow });
  edge.waypoint = waypoints.map((point) => moddle.create("dc:Point", point));
  const middle = waypoints[Math.floor(waypoints.length / 2)];
  if (flow.name && middle) {
    edge.label = label(document, labelBounds(flow.name, middle));
  }
  edge.$parent = plane;
  (plane.planeElement ??= []).push(edge);
}

export function removeDi(document: BpmnDocument, element: ModdleElement): void {
  for (const plane of planes(document)) {
    const list = plane.planeElement ?? [];
    const index = list.findIndex((di) => di.bpmnElement === element);
    if (index !== -1) {
      list.splice(index, 1);
    }
  }
}
