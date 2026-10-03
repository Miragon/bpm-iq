/**
 * Column gap and row spacing of a plane as its author drew it: the median over the flows between neighbours, so a
 * relayout fits in with the hand layout around it. Plain constants of layout-geometry.md are the bounds.
 */
import type { DiagramPlane } from "../../diagram/plane.ts";
import { COLUMN_GAP, MIN_SHAPE_GAP, ROW_SPACING } from "../constants.ts";
import { center, shapesById } from "../space.ts";

export interface Spacing {
  readonly columnGap: number;
  readonly rowSpacing: number;
}

/** Centres closer than this in y count as the same row. */
const SAME_ROW = 5;
const MIN_COLUMN_GAP = 2 * MIN_SHAPE_GAP;
const MIN_ROW_SPACING = 80;

function median(values: readonly number[]): number | undefined {
  const sorted = [...values].sort((first, second) => first - second);
  return sorted[Math.floor(sorted.length / 2)];
}

function clamp(value: number | undefined, low: number, high: number): number {
  return Math.min(high, Math.max(low, value ?? high));
}

/** The horizontal gap (same row) or the vertical distance (different rows) of one flow, if it tells anything. */
function sample(plane: DiagramPlane, edge: DiagramPlane["edges"][number]): { gap?: number; row?: number } {
  const byId = shapesById(plane);
  const source = byId.get(edge.source ?? "");
  const target = byId.get(edge.target ?? "");
  if (edge.type !== "SequenceFlow" || !source || !target || source.attachedTo) {
    return {};
  }
  const dy = Math.abs(center(target.bounds).y - center(source.bounds).y);
  const gap = target.bounds.x - (source.bounds.x + source.bounds.width);
  if (dy >= SAME_ROW) {
    return { row: dy };
  }
  return gap > 0 ? { gap } : {};
}

export function spacingOf(plane: DiagramPlane): Spacing {
  const samples = plane.edges.map((edge) => sample(plane, edge));
  const gaps = samples.flatMap((entry) => (entry.gap === undefined ? [] : [entry.gap]));
  const rows = samples.flatMap((entry) => (entry.row === undefined ? [] : [entry.row]));
  return {
    columnGap: clamp(median(gaps), MIN_COLUMN_GAP, COLUMN_GAP),
    rowSpacing: clamp(median(rows), MIN_ROW_SPACING, ROW_SPACING),
  };
}
