/**
 * Writes a layout result into the DI of a parsed document: bounds, waypoints and label bounds. bpmiq stickies carry
 * their coordinates on the extension element instead of in the DI (ADR 0008); each one follows the flow node nearest
 * to it, so a workshop note stays next to the step it annotates.
 */
import type { ModdleElement } from "bpmn-moddle";

import type { BpmnDocument } from "../model/document.ts";
import type { LayoutResult } from "./result.ts";

/** DI elements (shapes and edges of every plane) by the id of their semantic element. */
function diById(document: BpmnDocument): Map<string, ModdleElement> {
  const entries = (document.definitions.diagrams ?? []).flatMap((diagram) =>
    (diagram.plane?.planeElement ?? []).flatMap((di) => (di.bpmnElement?.id ? [[di.bpmnElement.id, di] as const] : [])),
  );
  return new Map(entries);
}

const STICKY = "bpmiq:Sticky";
/** DI shapes a sticky never anchors to: frames, not steps. */
const FRAME_TYPES: ReadonlySet<string> = new Set([
  "bpmn:Participant",
  "bpmn:Lane",
  "bpmn:Group",
  "bpmn:TextAnnotation",
]);

function stickiesOf(document: BpmnDocument): ModdleElement[] {
  return (document.definitions.rootElements ?? [])
    .filter((root) => root.$type === "bpmn:Process")
    .flatMap((process) => process.extensionElements?.values ?? [])
    .filter((value) => value.$type.toLowerCase() === STICKY.toLowerCase());
}

function centre(rect: { x: number; y: number; width: number; height: number }): { x: number; y: number } {
  return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 };
}

/** Distance from a point to a rectangle (0 inside). */
function distance(
  point: { x: number; y: number },
  rect: { x: number; y: number; width: number; height: number },
): number {
  const dx = Math.max(rect.x - point.x, 0, point.x - (rect.x + rect.width));
  const dy = Math.max(rect.y - point.y, 0, point.y - (rect.y + rect.height));
  return Math.hypot(dx, dy);
}

/** Moves every sticky by the shift of the centre of its nearest flow node on the root plane. */
function followStickies(document: BpmnDocument, result: LayoutResult): void {
  const stickies = stickiesOf(document);
  const moved = new Map(result.shapes.map((shape) => [shape.id, shape]));
  if (stickies.length === 0 || moved.size === 0) {
    return;
  }
  const shapes = (document.definitions.diagrams?.[0]?.plane?.planeElement ?? []).filter(
    (di) => di.$type === "bpmndi:BPMNShape" && di.bounds && di.bpmnElement && !FRAME_TYPES.has(di.bpmnElement.$type),
  );
  for (const sticky of stickies) {
    // untyped (no bpmiq descriptor is loaded, so the web modeler's spelling passes through): attributes are strings
    const [x, y, width, height] = [sticky.x, sticky.y, sticky.width ?? 0, sticky.height ?? 0].map(Number);
    if (x === undefined || y === undefined || !Number.isFinite(x) || !Number.isFinite(y)) {
      continue;
    }
    const point = centre({ x, y, width: width || 0, height: height || 0 });
    const far = Number.POSITIVE_INFINITY;
    const nearest = shapes.reduce<ModdleElement | undefined>(
      (best, di) =>
        !best || (di.bounds ? distance(point, di.bounds) : far) < (best.bounds ? distance(point, best.bounds) : far)
          ? di
          : best,
      undefined,
    );
    const after = nearest?.bpmnElement?.id ? moved.get(nearest.bpmnElement.id) : undefined;
    if (nearest?.bounds && after) {
      const [from, to] = [centre(nearest.bounds), centre(after)];
      sticky.x = Math.round(x + to.x - from.x);
      sticky.y = Math.round(y + to.y - from.y);
    }
  }
}

export function applyLayout(document: BpmnDocument, result: LayoutResult): void {
  const { moddle } = document;
  const byId = diById(document);
  followStickies(document, result);
  for (const { id, x, y, width, height } of result.shapes) {
    const di = byId.get(id);
    if (di) {
      di.bounds = moddle.create("dc:Bounds", { x, y, width, height });
    }
  }
  for (const { id, waypoints } of result.edges) {
    const di = byId.get(id);
    if (di) {
      di.waypoint = waypoints.map((point) => moddle.create("dc:Point", { x: point.x, y: point.y }));
    }
  }
  for (const { id, x, y, width, height } of result.labels) {
    const di = byId.get(id);
    if (di) {
      di.label ??= moddle.create("bpmndi:BPMNLabel");
      di.label.bounds = moddle.create("dc:Bounds", { x, y, width, height });
    }
  }
}
