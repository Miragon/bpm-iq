/**
 * End events stand in one column on the right of their plane (a layout rule: "end events in one column on the
 * right"), one column gap right of everything else. Each keeps its height, so the flow into it runs straight along
 * its row; an end event that would come too close to one above it on the column moves down. The end events move
 * one at a time from top to bottom, and each move is kept only when its new flows add no crossing, no shape overlap
 * and no flow through a shape. Every expanded sub-process and every pool has its own column, and the sub-process
 * (or the pool with its lanes) widens when the column needs it.
 */
import { type DiagramPlane, type DiagramShape, levelOf } from "../diagram/plane.ts";
import { measurePlane } from "../metrics/metrics.ts";
import { endEventColumns, isBackground } from "../metrics/rules.ts";
import { MIN_SHAPE_GAP } from "./constants.ts";
import { spacingOf } from "./relayout/spacing.ts";
import { settle } from "./reroute.ts";
import { withinHardLimits } from "./score.ts";
import { moveShape } from "./space.ts";

interface Column {
  readonly x: number;
  /** vertical ranges of the end events already on the column, labels included */
  readonly taken: (readonly [number, number])[];
}

/** Top and bottom of an end event with its label below it. */
function extent(shape: DiagramShape, top: number): readonly [number, number] {
  const labelBottom = shape.label ? shape.label.y + shape.label.height - shape.bounds.y : 0;
  return [top, top + Math.max(shape.bounds.height, labelBottom)];
}

/** Its own height, or lower until it keeps the minimum gap to every end event already on the column. */
function freeTop(shape: DiagramShape, column: Column): number {
  let top = shape.bounds.y;
  for (let moved = true; moved;) {
    const [start, end] = extent(shape, top);
    const blocking = column.taken.find(([from, to]) => start < to + MIN_SHAPE_GAP && end + MIN_SHAPE_GAP > from);
    moved = blocking !== undefined;
    top = blocking ? blocking[1] + MIN_SHAPE_GAP : top;
  }
  return top;
}

/** The frame of the column (a sub-process, or a pool with its lanes) reaches at least to `right`. */
function widenFrame(plane: DiagramPlane, column: string, right: number): DiagramPlane {
  const widened = (shape: DiagramShape): DiagramShape => {
    const frame = shape.id === column || (shape.type === "Lane" && shape.pool === column);
    const width = right - shape.bounds.x;
    return frame && width > shape.bounds.width ? { ...shape, bounds: { ...shape.bounds, width } } : shape;
  };
  return { ...plane, shapes: plane.shapes.map(widened) };
}

function alignColumn(plane: DiagramPlane, ends: readonly DiagramShape[], moved: Set<string>): DiagramPlane {
  const key = ends[0] ? levelOf(ends[0]) : "";
  const others = plane.shapes.filter(
    (shape) => !isBackground(shape) && !ends.includes(shape) && levelOf(shape) === key,
  );
  if (others.length === 0) {
    return plane;
  }
  const right = Math.max(...others.map((shape) => shape.bounds.x + shape.bounds.width));
  const column: Column = { x: right + spacingOf(plane).columnGap, taken: [] };
  const ordered = [...ends].sort((first, second) => first.bounds.y - second.bounds.y);
  return ordered.reduce((current, end) => {
    const top = freeTop(end, column);
    const shifted: DiagramPlane = {
      ...current,
      shapes: current.shapes.map((shape) =>
        shape.id === end.id ? moveShape(shape, column.x - shape.bounds.x, top - shape.bounds.y) : shape,
      ),
    };
    const candidate = settle(widenFrame(shifted, key, column.x + end.bounds.width + MIN_SHAPE_GAP), new Set([end.id]));
    if (!withinHardLimits(candidate, measurePlane(current))) {
      return current;
    }
    column.taken.push(extent(end, top));
    moved.add(end.id);
    return candidate;
  }, plane);
}

export function alignEndEvents(plane: DiagramPlane): { plane: DiagramPlane; moved: Set<string> } {
  const moved = new Set<string>();
  const aligned = endEventColumns(plane).reduce((current, ends) => alignColumn(current, ends, moved), plane);
  return { plane: aligned, moved };
}
