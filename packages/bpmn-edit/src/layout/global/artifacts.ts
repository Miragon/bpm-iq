/**
 * Artifacts in the global layout: a text annotation or a data object keeps its offset to the flow node it is
 * associated with, and every association is drawn as a straight line between the borders of its two shapes (an
 * association may run at an angle).
 */
import type { DiagramEdge, DiagramPlane, DiagramShape } from "../../diagram/plane.ts";
import type { Point, Rect } from "../../geometry/geometry.ts";
import { center } from "../space.ts";

const ARTIFACTS: ReadonlySet<string> = new Set(["TextAnnotation", "DataObjectReference", "DataStoreReference"]);

export function isArtifact(shape: DiagramShape): boolean {
  return ARTIFACTS.has(shape.type);
}

function isAssociation(edge: DiagramEdge): boolean {
  return edge.type.endsWith("Association");
}

/** The node an artifact is associated with: the other end of its first association. */
function anchorOf(plane: DiagramPlane, artifact: string): string | undefined {
  const edge = plane.edges.find(
    (candidate) => isAssociation(candidate) && [candidate.source, candidate.target].includes(artifact),
  );
  return edge?.source === artifact ? edge.target : edge?.source;
}

/** New bounds of the artifacts: their old offset to the centre of their anchor, at its new centre. */
export function placeArtifacts(plane: DiagramPlane, placed: Map<string, Rect>): void {
  const byId = new Map(plane.shapes.map((shape) => [shape.id, shape]));
  for (const artifact of plane.shapes.filter(isArtifact)) {
    const anchor = anchorOf(plane, artifact.id);
    const before = byId.get(anchor ?? "")?.bounds;
    const after = placed.get(anchor ?? "");
    if (before && after) {
      const [old, now] = [center(before), center(after)];
      placed.set(artifact.id, {
        ...artifact.bounds,
        x: artifact.bounds.x + now.x - old.x,
        y: artifact.bounds.y + now.y - old.y,
      });
    }
  }
}

/** Where the line from the centre of `rect` towards `target` leaves the rectangle. */
function exitPoint(rect: Rect, target: Point): Point {
  const from = center(rect);
  const [dx, dy] = [target.x - from.x, target.y - from.y];
  const scale = Math.min(
    dx === 0 ? Infinity : rect.width / 2 / Math.abs(dx),
    dy === 0 ? Infinity : rect.height / 2 / Math.abs(dy),
  );
  const factor = Number.isFinite(scale) ? Math.min(1, scale) : 0;
  return { x: Math.round(from.x + dx * factor), y: Math.round(from.y + dy * factor) };
}

/** Every association as a straight line between the borders of its shapes. */
export function straightAssociations(plane: DiagramPlane): DiagramPlane {
  const bounds = new Map(plane.shapes.map((shape) => [shape.id, shape.bounds]));
  return {
    ...plane,
    edges: plane.edges.map((edge) => {
      const [source, target] = [bounds.get(edge.source ?? ""), bounds.get(edge.target ?? "")];
      if (!isAssociation(edge) || !source || !target) {
        return edge;
      }
      return { ...edge, waypoints: [exitPoint(source, center(target)), exitPoint(target, center(source))] };
    }),
  };
}
