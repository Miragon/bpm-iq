/**
 * Common starts of orthogonal polylines: the branches of a split leave their source on one trunk and fork behind it,
 * so the stretch two flows share from their common start is a fork, not an overlap.
 */
import { EPSILON, type Point, segmentLength } from "./geometry.ts";

function distance(first: Point, second: Point): number {
  return segmentLength([first, second]);
}

function sameDirection(from: Point, first: Point, second: Point): boolean {
  return (
    Math.sign(first.x - from.x) === Math.sign(second.x - from.x) &&
    Math.sign(first.y - from.y) === Math.sign(second.y - from.y)
  );
}

/** The point `step` px from `from` towards `to`. */
function towards(from: Point, to: Point, step: number): Point {
  return { x: from.x + Math.sign(to.x - from.x) * step, y: from.y + Math.sign(to.y - from.y) * step };
}

/** Index of the first point from `index` on that lies away from `current` (repeated waypoints skipped). */
function nextAway(points: readonly Point[], index: number, current: Point): number {
  let next = index;
  while (next < points.length && distance(current, points[next] ?? current) < EPSILON) {
    next++;
  }
  return next;
}

/** Length of the way two orthogonal polylines share from their start; 0 when they start apart. */
export function sharedStart(first: readonly Point[], second: readonly Point[]): number {
  let [current, length] = [first[0], 0];
  const start = second[0];
  if (!current || !start || distance(current, start) > EPSILON) {
    return 0;
  }
  let [i, j] = [nextAway(first, 1, current), nextAway(second, 1, current)];
  for (let [a, b] = [first[i], second[j]]; a && b && sameDirection(current, a, b); [a, b] = [first[i], second[j]]) {
    const step = Math.min(distance(current, a), distance(current, b));
    current = towards(current, a, step);
    length += step;
    [i, j] = [nextAway(first, i, current), nextAway(second, j, current)];
  }
  return length;
}

/** The polyline without its first `length` px; unchanged for a length of 0. */
export function trimStart(points: readonly Point[], length: number): Point[] {
  let rest = length;
  for (let index = 1; index < points.length; index++) {
    const [from, to] = [points[index - 1], points[index]];
    if (!from || !to) {
      break;
    }
    const piece = distance(from, to);
    if (rest < piece - EPSILON) {
      return [towards(from, to, rest), ...points.slice(index)];
    }
    rest -= piece;
  }
  return length > 0 ? points.slice(-1) : [...points];
}
