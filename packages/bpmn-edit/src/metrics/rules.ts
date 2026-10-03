/**
 * Metrics for the layout rules (layout/constants.ts) that are no geometry defect of their own: flows that leave their
 * source on a side it may not be left by (an activity elsewhere than right, a gateway to the left), end events that
 * do not stand in the one column on the right, and flow nodes drawn outside their lane or pool.
 */
import { type DiagramEdge, type DiagramPlane, type DiagramShape, frameOf, levelOf } from "../diagram/plane.ts";
import { type Rect, rectsOverlap } from "../geometry/geometry.ts";
import { leavesAllowedSide } from "../layout/router/ports.ts";

/** Sequence flows that leave their source on a side it may not be left by, such as a gateway to the left. */
export function wrongSideFlows(plane: DiagramPlane): DiagramEdge[] {
  const byId = new Map(plane.shapes.map((shape) => [shape.id, shape]));
  return plane.edges.filter((edge) => {
    const source = byId.get(edge.source ?? "");
    const start = edge.waypoints[0];
    return (
      edge.type === "SequenceFlow" && source !== undefined && start !== undefined && !leavesAllowedSide(source, start)
    );
  });
}

export function countWrongSides(plane: DiagramPlane): number {
  return wrongSideFlows(plane).length;
}

/**
 * End events on a plane that stand in one column: grouped by the expanded sub-process that holds them, otherwise by
 * pool; those inside a group (the artifact) are left out.
 */
export function endEventColumns(plane: DiagramPlane): DiagramShape[][] {
  const groups = plane.shapes.filter((shape) => shape.type === "Group");
  const ends = plane.shapes.filter(
    (shape) => shape.type === "EndEvent" && !groups.some((group) => rectsOverlap(group.bounds, shape.bounds)),
  );
  const columns = new Map<string, DiagramShape[]>();
  for (const end of ends) {
    const key = levelOf(end);
    columns.set(key, [...(columns.get(key) ?? []), end]);
  }
  return [...columns.values()];
}

const BACKGROUND: ReadonlySet<string> = new Set(["Participant", "Lane", "Group"]);

/** Pools, lanes and groups: they frame the content, an expanded sub-process by contrast is a shape of its level. */
export function isBackground(shape: DiagramShape): boolean {
  return BACKGROUND.has(shape.type);
}

/**
 * End events that are not on the column of their pool (or plane): left of its rightmost end event, or with another
 * shape of the pool reaching as far right as they stand.
 */
export function countEndEventsOffColumn(plane: DiagramPlane): number {
  return endEventColumns(plane)
    .map((ends) => {
      const key = ends[0] ? levelOf(ends[0]) : "";
      const others = plane.shapes.filter(
        (shape) => !isBackground(shape) && !ends.includes(shape) && levelOf(shape) === key,
      );
      const column = Math.max(...ends.map((end) => end.bounds.x));
      return ends.filter(
        (end) => end.bounds.x !== column || others.some((shape) => shape.bounds.x + shape.bounds.width > end.bounds.x),
      ).length;
    })
    .reduce((sum, count) => sum + count, 0);
}

function centreInside(inner: Rect, outer: Rect): boolean {
  const x = inner.x + inner.width / 2;
  const y = inner.y + inner.height / 2;
  return x >= outer.x && x <= outer.x + outer.width && y >= outer.y && y <= outer.y + outer.height;
}

/** Flow nodes whose centre lies outside their expanded sub-process, their lane or (without one) their pool. */
export function outsideFrames(plane: DiagramPlane): DiagramShape[] {
  const byId = new Map(plane.shapes.map((shape) => [shape.id, shape]));
  return plane.shapes.filter((shape) => {
    const frame = byId.get(frameOf(shape));
    return shape.type !== "Lane" && frame !== undefined && !centreInside(shape.bounds, frame.bounds);
  });
}

export function countOutsideFrames(plane: DiagramPlane): number {
  return outsideFrames(plane).length;
}
