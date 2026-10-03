/**
 * Closes empty strips: a range of x (or y) without any shape, label or bend of a flow, which flows only cross
 * straight and which is more than twice as wide as the column gap (or the free space between two rows) of the plane,
 * is narrowed to that gap. Narrower strips are the author's choice and stay. Everything beyond it
 * moves back by the space tool; the crossing flows get shorter, nothing else changes. Space tool steps of a relayout
 * leave such strips behind when the room they made was not needed everywhere.
 */
import type { DiagramPlane } from "../diagram/plane.ts";
import { EPSILON } from "../geometry/geometry.ts";
import { MIN_SHAPE_GAP, SIZES } from "./constants.ts";
import { spacingOf } from "./relayout/spacing.ts";
import { type Axis, makeSpace } from "./space.ts";

type Interval = readonly [number, number];

/** A strip closes only when it is wider than this many gaps of the plane. */
const EMPTY_STRIP_FACTOR = 2;

/**
 * What occupies the plane along one axis: shapes, labels, the bends and ends of flows, and the borders of pools,
 * lanes and other containers (a strip never closes across a border, the content keeps its padding to it).
 */
function occupied(plane: DiagramPlane, axis: Axis): Interval[] {
  const size = axis === "x" ? "width" : "height";
  const shapes = plane.shapes.filter((shape) => !shape.container);
  const borders = plane.shapes
    .filter((shape) => shape.container)
    .flatMap((shape): Interval[] => {
      const start = shape.bounds[axis];
      const end = start + shape.bounds[size];
      return [
        [start, start],
        [end, end],
      ];
    });
  const boxes = [
    ...shapes.map((shape) => shape.bounds),
    ...[...shapes, ...plane.edges].flatMap((element) => (element.label ? [element.label] : [])),
  ];
  return [
    ...borders,
    ...boxes.map((box): Interval => [box[axis], box[axis] + box[size]]),
    ...plane.edges.flatMap((edge) => edge.waypoints.map((point): Interval => [point[axis], point[axis]])),
  ].sort((first, second) => first[0] - second[0]);
}

/** Empty ranges too wide for `gap` between the occupied parts, from right to left (bottom to top). */
function emptyStrips(intervals: readonly Interval[], gap: number): Interval[] {
  const strips: Interval[] = [];
  let reach = intervals[0]?.[1] ?? 0;
  for (const [start, end] of intervals) {
    if (start - reach > EMPTY_STRIP_FACTOR * gap + EPSILON) {
      strips.push([reach, start]);
    }
    reach = Math.max(reach, end);
  }
  return strips.reverse();
}

function closeStrips(plane: DiagramPlane, axis: Axis, gap: number): { plane: DiagramPlane; moved: Set<string> } {
  const moved = new Set<string>();
  const closed = emptyStrips(occupied(plane, axis), gap).reduce((current, [start, end]) => {
    const shifted = makeSpace(current, { axis, line: end, delta: -(end - start - gap) });
    shifted.moved.forEach((id) => moved.add(id));
    return shifted.plane;
  }, plane);
  return { plane: closed, moved };
}

export function compact(plane: DiagramPlane): { plane: DiagramPlane; moved: Set<string> } {
  const { columnGap, rowSpacing } = spacingOf(plane);
  const rowGap = Math.max(2 * MIN_SHAPE_GAP, rowSpacing - SIZES.activity.height);
  const columns = closeStrips(plane, "x", columnGap);
  const rows = closeStrips(columns.plane, "y", rowGap);
  return { plane: rows.plane, moved: new Set([...columns.moved, ...rows.moved]) };
}
