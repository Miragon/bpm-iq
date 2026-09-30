/** Label metric: external labels that cover a shape, a flow or another label. */
import type { DiagramPlane, DiagramShape } from "../diagram/plane.ts";
import { boxesMeet, type Rect, rectsOverlap, segmentCrossesRect } from "../geometry/geometry.ts";
import type { FlowPath } from "./edges.ts";
import { obstacles } from "./shapes.ts";

interface Label {
  readonly owner: string;
  readonly bounds: Rect;
}

export function labelsOf(plane: DiagramPlane): Label[] {
  const owned = [...plane.shapes, ...plane.edges].map((element) => ({ owner: element.id, bounds: element.label }));
  return owned.filter((label): label is Label => label.bounds !== undefined);
}

function coveredShapes(label: Label, blocking: readonly DiagramShape[]): number {
  return blocking.filter((shape) => shape.id !== label.owner && rectsOverlap(label.bounds, shape.bounds)).length;
}

function coveredFlows(label: Label, paths: readonly FlowPath[]): number {
  return paths.filter(
    (path) =>
      path.edge.id !== label.owner &&
      boxesMeet(path.box, label.bounds) &&
      path.segments.some((segment) => segmentCrossesRect(segment, label.bounds)),
  ).length;
}

/**
 * Counts every label-shape, label-flow and label-label pair that overlaps. A label may touch its own element and
 * its own flow; the flows leaving a labelled gateway or event are foreign to that label and count.
 */
export function countLabelOverlaps(plane: DiagramPlane, paths: readonly FlowPath[]): number {
  const labels = labelsOf(plane);
  const blocking = obstacles(plane.shapes);
  let count = 0;
  labels.forEach((label, index) => {
    count += coveredShapes(label, blocking) + coveredFlows(label, paths);
    count += labels.slice(index + 1).filter((other) => rectsOverlap(label.bounds, other.bounds)).length;
  });
  return count;
}
