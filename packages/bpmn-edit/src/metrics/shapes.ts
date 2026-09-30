/** Shape metrics: overlapping shapes and shapes closer than the minimum gap of the layout rules. */
import type { DiagramShape } from "../diagram/plane.ts";
import { rectGap, rectsOverlap } from "../geometry/geometry.ts";

/** Minimum free space between two shapes (the layout geometry of layout/constants.ts). */
export const MIN_SHAPE_GAP = 20;

export interface ShapeProblems {
  readonly overlaps: number;
  readonly gapViolations: number;
}

/** Shapes that block space: everything except containers (pools, lanes, groups, expanded sub-processes). */
export function obstacles(shapes: readonly DiagramShape[]): DiagramShape[] {
  return shapes.filter((shape) => !shape.container);
}

/** A boundary event sits on the border of its host by definition. */
function attached(first: DiagramShape, second: DiagramShape): boolean {
  return first.attachedTo === second.id || second.attachedTo === first.id;
}

export function countShapeProblems(shapes: readonly DiagramShape[]): ShapeProblems {
  const candidates = obstacles(shapes);
  let overlaps = 0;
  let gapViolations = 0;
  candidates.forEach((first, index) => {
    for (const second of candidates.slice(index + 1)) {
      if (attached(first, second)) {
        continue;
      }
      if (rectsOverlap(first.bounds, second.bounds)) {
        overlaps++;
      } else if (rectGap(first.bounds, second.bounds) < MIN_SHAPE_GAP) {
        gapViolations++;
      }
    }
  });
  return { overlaps, gapViolations };
}
