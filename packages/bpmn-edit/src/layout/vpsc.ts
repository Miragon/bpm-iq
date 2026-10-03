/**
 * Overlap removal with the smallest displacement that keeps the left-to-right and top-to-bottom order of the shapes
 * (VPSC, variable placement with separation constraints, through WebCola): first horizontally, then vertically for
 * what is left. Every shape keeps MIN_SHAPE_GAP to the next; pinned shapes carry a weight that keeps them in place;
 * the frames around the group (pools, lanes, a sub-process) grow or shrink with it.
 */
import cola from "webcola";

import type { DiagramShape } from "../diagram/plane.ts";
import { type Rect, rectGap } from "../geometry/geometry.ts";
import { MIN_SHAPE_GAP } from "./constants.ts";
import type { Axis, Frame, Placed } from "./frames.ts";

const { Rectangle, Solver, Variable, generateXConstraints, generateYConstraints } = cola;
type ColaRectangle = InstanceType<typeof Rectangle>;

// half a pixel of slack so that rounding never leaves a gap just below the minimum
const HALF_GAP = (MIN_SHAPE_GAP + 1) / 2;
/** Displacements below one pixel are rounding noise of the solver; they would only bend straight flows. */
const NOISE = 1;
/** A shift up to this size on one axis is taken back when the shape still keeps its distance without it. */
const SNAP = 5;
/** Weight of a pinned shape against 1 for a free one: the solver moves the free ones. */
const PINNED_WEIGHT = 1e6;

type Spans = Map<string, readonly [number, number]>;

/** The frames the shapes of one group have to stay in, for one axis. */
export type FrameProvider = (placed: readonly Placed[], axis: Axis) => Frame;

/** Solves one axis for the shapes and the frames around them; returns the new spans of the frames. */
function solveAxis(
  free: readonly DiagramShape[],
  context: { readonly frames: FrameProvider; readonly rectangles: readonly ColaRectangle[] },
  weights: readonly number[],
  axis: Axis,
): Spans {
  const { frames, rectangles } = context;
  const variables = rectangles.map(
    (rectangle, index) => new Variable(axis === "x" ? rectangle.cx() : rectangle.cy(), weights[index]),
  );
  const constraints =
    axis === "x" ? generateXConstraints([...rectangles], variables) : generateYConstraints([...rectangles], variables);
  const placed: Placed[] = free.flatMap((shape, index) => {
    const [rectangle, variable] = [rectangles[index], variables[index]];
    const extent = axis === "x" ? rectangle?.width() : rectangle?.height();
    // the frame keeps its padding to the shape itself, not to the solver's rectangle with its gap
    return rectangle && variable && extent !== undefined ? [{ shape, variable, half: extent / 2 - HALF_GAP }] : [];
  });
  const frame = frames(placed, axis);
  new Solver([...variables, ...frame.variables], [...constraints, ...frame.constraints]).solve();
  variables.forEach((variable, index) => {
    const rectangle = rectangles[index];
    if (axis === "x") {
      rectangle?.setXCentre(variable.position());
    } else {
      rectangle?.setYCentre(variable.position());
    }
  });
  return frame.spans();
}

export interface Solution {
  /** displacement per shape of the group, rounded to whole pixels, small sideways shifts taken back */
  readonly deltas: Map<string, readonly [number, number]>;
  /** new bounds of the frames (pools, lanes, the sub-process around the group) */
  readonly frames: Map<string, Rect>;
}

function frameBounds(boundsOf: (id: string) => Rect | undefined, xs: Spans, ys: Spans): Map<string, Rect> {
  return new Map(
    [...new Set([...xs.keys(), ...ys.keys()])].flatMap((id) => {
      const bounds = boundsOf(id);
      if (!bounds) {
        return [];
      }
      const [x, width] = xs.get(id) ?? [bounds.x, bounds.width];
      const [y, height] = ys.get(id) ?? [bounds.y, bounds.height];
      return [[id, { x, y, width, height }] as const];
    }),
  );
}

/**
 * Overlap removal for one group of shapes inside its frames: displacement per shape and the new bounds of the
 * frames. `boundsOf` gives the current bounds of a frame.
 */
export function solveGroup(
  shapes: readonly DiagramShape[],
  pinned: ReadonlySet<string>,
  frames: FrameProvider,
  boundsOf: (id: string) => Rect | undefined,
): Solution {
  const rectangles = shapes.map(
    ({ bounds }) =>
      new Rectangle(
        bounds.x - HALF_GAP,
        bounds.x + bounds.width + HALF_GAP,
        bounds.y - HALF_GAP,
        bounds.y + bounds.height + HALF_GAP,
      ),
  );
  const weights = shapes.map((shape) => (pinned.has(shape.id) ? PINNED_WEIGHT : 1));
  const xs = solveAxis(shapes, { frames, rectangles }, weights, "x");
  const ys = solveAxis(shapes, { frames, rectangles }, weights, "y");
  const deltas = new Map(
    shapes.map((shape, index) => {
      const rectangle = rectangles[index];
      const dx = rectangle ? rectangle.x + HALF_GAP - shape.bounds.x : 0;
      const dy = rectangle ? rectangle.y + HALF_GAP - shape.bounds.y : 0;
      const snap = (delta: number): number => (Math.abs(delta) < NOISE ? 0 : Math.round(delta));
      return [shape.id, [snap(dx), snap(dy)] as const];
    }),
  );
  return { deltas: snapSmallShifts(shapes, deltas), frames: frameBounds(boundsOf, xs, ys) };
}

type Deltas = Map<string, readonly [number, number]>;

function shifted(shape: DiagramShape, delta: readonly [number, number]): DiagramShape["bounds"] {
  return { ...shape.bounds, x: shape.bounds.x + delta[0], y: shape.bounds.y + delta[1] };
}

/** True when the shape at the given delta keeps MIN_SHAPE_GAP to every other free shape at its final place. */
function keepsDistance(
  shape: DiagramShape,
  delta: readonly [number, number],
  shapes: readonly DiagramShape[],
  deltas: Deltas,
): boolean {
  const bounds = shifted(shape, delta);
  return shapes.every(
    (other) =>
      other.id === shape.id || rectGap(bounds, shifted(other, deltas.get(other.id) ?? [0, 0])) >= MIN_SHAPE_GAP,
  );
}

/**
 * Takes back small shifts on one axis where the shape keeps its distance without them: the solver moves shapes a
 * few pixels sideways, which only breaks rows and bends straight flows.
 */
function snapSmallShifts(shapes: readonly DiagramShape[], solved: Deltas): Deltas {
  const deltas: Deltas = new Map(solved);
  for (const shape of shapes) {
    const [dx, dy] = deltas.get(shape.id) ?? [0, 0];
    const candidates: (readonly [number, number])[] = [];
    if (dy !== 0 && Math.abs(dy) <= SNAP) {
      candidates.push([dx, 0]);
    }
    if (dx !== 0 && Math.abs(dx) <= SNAP) {
      candidates.push([0, dy]);
    }
    const accepted = candidates.find((candidate) => keepsDistance(shape, candidate, shapes, deltas));
    if (accepted) {
      deltas.set(shape.id, accepted);
    }
  }
  return revertViolations(shapes, solved, deltas);
}

/**
 * A snap was checked against neighbours that may have snapped later; every snapped shape that no longer keeps its
 * distance at the final places gets its solver shift back, until no snap violates the minimum gap.
 */
function revertViolations(shapes: readonly DiagramShape[], solved: Deltas, deltas: Deltas): Deltas {
  for (let changed = true; changed;) {
    changed = false;
    for (const shape of shapes) {
      const own = deltas.get(shape.id) ?? [0, 0];
      const original = solved.get(shape.id) ?? [0, 0];
      const snapped = own[0] !== original[0] || own[1] !== original[1];
      if (snapped && !keepsDistance(shape, own, shapes, deltas)) {
        deltas.set(shape.id, original);
        changed = true;
      }
    }
  }
  return deltas;
}
