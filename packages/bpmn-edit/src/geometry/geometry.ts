/** Plane geometry on diagram coordinates (x to the right, y downwards), as the BPMN DI uses it. */

export interface Point {
  readonly x: number;
  readonly y: number;
}

export interface Rect extends Point {
  readonly width: number;
  readonly height: number;
}

export type Segment = readonly [Point, Point];

/** Coordinates in the DI are floating point; anything closer than this counts as equal. */
export const EPSILON = 0.5;

/** The bounding box of a polyline. */
export function boxOf(points: readonly Point[]): Rect {
  let [left, top, right, bottom] = [Infinity, Infinity, -Infinity, -Infinity];
  for (const { x, y } of points) {
    left = Math.min(left, x);
    top = Math.min(top, y);
    right = Math.max(right, x);
    bottom = Math.max(bottom, y);
  }
  return { x: left, y: top, width: right - left, height: bottom - top };
}

/** Whether two boxes touch or overlap: the cheap test before the exact segment tests. */
export function boxesMeet(first: Rect, second: Rect): boolean {
  return (
    first.x <= second.x + second.width + EPSILON &&
    second.x <= first.x + first.width + EPSILON &&
    first.y <= second.y + second.height + EPSILON &&
    second.y <= first.y + first.height + EPSILON
  );
}

export function segmentsOf(points: readonly Point[]): Segment[] {
  const segments: Segment[] = [];
  for (let index = 1; index < points.length; index++) {
    const start = points[index - 1];
    const end = points[index];
    if (start && end) {
      segments.push([start, end]);
    }
  }
  return segments;
}

export function segmentLength([start, end]: Segment): number {
  return Math.hypot(end.x - start.x, end.y - start.y);
}

/** True when the interiors of both rectangles overlap; touching edges do not count. */
export function rectsOverlap(first: Rect, second: Rect): boolean {
  return (
    first.x + EPSILON < second.x + second.width &&
    second.x + EPSILON < first.x + first.width &&
    first.y + EPSILON < second.y + second.height &&
    second.y + EPSILON < first.y + first.height
  );
}

/** Free space between two rectangles along the axis that separates them; 0 when they overlap or touch. */
export function rectGap(first: Rect, second: Rect): number {
  const gapX = Math.max(second.x - (first.x + first.width), first.x - (second.x + second.width));
  const gapY = Math.max(second.y - (first.y + first.height), first.y - (second.y + second.height));
  return Math.max(0, gapX, gapY);
}

/**
 * Side of `second` relative to the line from `origin` through `first`: -1, 1, or 0 when it lies within EPSILON of
 * the line. The cross product is divided by the line length so that EPSILON stays a distance in px, independent of
 * how long the segment is.
 */
function orientation(origin: Point, first: Point, second: Point): number {
  const length = Math.hypot(first.x - origin.x, first.y - origin.y);
  if (length === 0) {
    return 0;
  }
  const cross = (first.x - origin.x) * (second.y - origin.y) - (first.y - origin.y) * (second.x - origin.x);
  return Math.abs(cross / length) < EPSILON ? 0 : Math.sign(cross);
}

/** True for a proper crossing: both segments pass through each other; touching at an end point does not count. */
export function segmentsCross([a, b]: Segment, [c, d]: Segment): boolean {
  const abc = orientation(a, b, c);
  const abd = orientation(a, b, d);
  const cda = orientation(c, d, a);
  const cdb = orientation(c, d, b);
  return abc * abd < 0 && cda * cdb < 0;
}

function isHorizontal([start, end]: Segment): boolean {
  return Math.abs(start.y - end.y) < EPSILON;
}

function isVertical([start, end]: Segment): boolean {
  return Math.abs(start.x - end.x) < EPSILON;
}

function intervalOverlap(a1: number, a2: number, b1: number, b2: number): number {
  return Math.min(Math.max(a1, a2), Math.max(b1, b2)) - Math.max(Math.min(a1, a2), Math.min(b1, b2));
}

/** Length on which two axis-parallel segments lie on top of each other; 0 for all other pairs. */
export function collinearOverlap(first: Segment, second: Segment): number {
  const [a, b] = first;
  const [c, d] = second;
  if (isHorizontal(first) && isHorizontal(second) && Math.abs(a.y - c.y) < EPSILON) {
    return Math.max(0, intervalOverlap(a.x, b.x, c.x, d.x));
  }
  if (isVertical(first) && isVertical(second) && Math.abs(a.x - c.x) < EPSILON) {
    return Math.max(0, intervalOverlap(a.y, b.y, c.y, d.y));
  }
  return 0;
}

/** Liang-Barsky clipping: true when the segment runs through the interior of the rectangle, shrunk by EPSILON. */
export function segmentCrossesRect([start, end]: Segment, rect: Rect): boolean {
  const dx = end.x - start.x;
  const dy = end.y - start.y;
  const checks: readonly (readonly [number, number])[] = [
    [-dx, start.x - (rect.x + EPSILON)],
    [dx, rect.x + rect.width - EPSILON - start.x],
    [-dy, start.y - (rect.y + EPSILON)],
    [dy, rect.y + rect.height - EPSILON - start.y],
  ];
  let enter = 0;
  let leave = 1;
  for (const [direction, distance] of checks) {
    if (direction === 0) {
      if (distance < 0) {
        return false;
      }
      continue;
    }
    const ratio = distance / direction;
    if (direction < 0) {
      enter = Math.max(enter, ratio);
    } else {
      leave = Math.min(leave, ratio);
    }
  }
  return enter < leave;
}

/** True when the path changes direction at `corner`. */
export function isBend(before: Point, corner: Point, after: Point): boolean {
  return orientation(before, corner, after) !== 0;
}

/** Smallest rectangle around all rectangles and points; undefined for no input. */
export function boundingBox(rects: readonly Rect[], points: readonly Point[]): Rect | undefined {
  const xs = [...rects.flatMap((rect) => [rect.x, rect.x + rect.width]), ...points.map((point) => point.x)];
  const ys = [...rects.flatMap((rect) => [rect.y, rect.y + rect.height]), ...points.map((point) => point.y)];
  if (xs.length === 0) {
    return undefined;
  }
  const x = Math.min(...xs);
  const y = Math.min(...ys);
  return { x, y, width: Math.max(...xs) - x, height: Math.max(...ys) - y };
}
