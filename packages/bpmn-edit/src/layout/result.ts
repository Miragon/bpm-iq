/**
 * The result of a layout as geometry, never XML: the shape of `LayoutResult` of the bpmn-modeler layout port
 * (`libs/bpmn-layout/src/types.ts` in the bpmn-modeler repository) plus absolute label bounds. An element without
 * an entry keeps its geometry, so a consumer can apply the result without losing what the layout does not know.
 */
import type { DiagramPlane } from "../diagram/plane.ts";
import type { Point, Rect } from "../geometry/geometry.ts";

export interface ShapeGeometry extends Rect {
  readonly id: string;
}

export interface EdgeGeometry {
  readonly id: string;
  readonly waypoints: readonly Point[];
}

export interface LayoutDiagnostic {
  readonly message: string;
  readonly elementId?: string;
}

export interface LayoutResult {
  readonly shapes: readonly ShapeGeometry[];
  readonly edges: readonly EdgeGeometry[];
  /** absolute bounds of external labels, keyed by the id of the labelled element */
  readonly labels: readonly ShapeGeometry[];
  readonly diagnostics: readonly LayoutDiagnostic[];
}

function sameRect(first: Rect | undefined, second: Rect | undefined): boolean {
  if (!first || !second) {
    return first === second;
  }
  return first.x === second.x && first.y === second.y && first.width === second.width && first.height === second.height;
}

function samePoints(first: readonly Point[], second: readonly Point[]): boolean {
  return (
    first.length === second.length &&
    first.every((point, index) => point.x === second[index]?.x && point.y === second[index]?.y)
  );
}

function roundPoint(point: Point): Point {
  return { x: Math.round(point.x), y: Math.round(point.y) };
}

function roundRect(rect: Rect): Rect {
  return { ...roundPoint(rect), width: Math.round(rect.width), height: Math.round(rect.height) };
}

/** The geometry that differs between two versions of the same plane, rounded to whole pixels. */
export function diffPlane(before: DiagramPlane, after: DiagramPlane): Omit<LayoutResult, "diagnostics"> {
  // both sides rounded: coordinates the layout did not touch must not count as changed
  const oldShapes = new Map(before.shapes.map((shape) => [shape.id, roundRect(shape.bounds)]));
  const oldEdges = new Map(before.edges.map((edge) => [edge.id, edge.waypoints.map(roundPoint)]));
  const oldLabels = new Map(
    [...before.shapes, ...before.edges].map((element) => [element.id, element.label && roundRect(element.label)]),
  );
  const shapes = after.shapes
    .map((shape) => ({ id: shape.id, ...roundRect(shape.bounds) }))
    .filter((shape) => !sameRect(shape, oldShapes.get(shape.id)));
  const edges = after.edges
    .map((edge) => ({ id: edge.id, waypoints: edge.waypoints.map(roundPoint) }))
    .filter((edge) => !samePoints(edge.waypoints, oldEdges.get(edge.id) ?? []));
  const labels = [...after.shapes, ...after.edges]
    .flatMap((element) => (element.label ? [{ id: element.id, ...roundRect(element.label) }] : []))
    .filter((label) => !sameRect(label, oldLabels.get(label.id)));
  return { shapes, edges, labels };
}
