/**
 * Pools with their lanes, and expanded sub-processes, as frames for the overlap removal (VPSC): the borders of every pool and of its lanes (nested
 * lanes within their parent lane) become solver variables, and every flow node has to keep a padding to the borders
 * of its innermost lane (or pool) on both axes. The solver then moves shapes and borders together with the smallest displacement: a crowded lane grows and
 * pushes the lanes below it down, a shape never leaves its lane, a pool widens where its content needs it, and pools
 * stacked on each other keep their order.
 */
import cola from "webcola";

import type { DiagramShape } from "../diagram/plane.ts";
import type { Rect } from "../geometry/geometry.ts";
import { MIN_SHAPE_GAP } from "./constants.ts";

const { Constraint, Variable } = cola;
type ColaVariable = InstanceType<typeof Variable>;
type ColaConstraint = InstanceType<typeof Constraint>;

export type Axis = "x" | "y";

/** Free space between a flow node and the border of its lane or pool. */
const PADDING = MIN_SHAPE_GAP;
/** Smallest height of a lane and smallest width of a pool body. */
const MIN_BAND = 2 * PADDING;
/** Width of the name strip of a pool without lanes (the modeler's default). */
const POOL_HEADER = 30;

/** A shape that takes part in the overlap removal: its solver variable holds its centre on the axis. */
export interface Placed {
  readonly shape: DiagramShape;
  readonly variable: ColaVariable;
  /** half the extent of the shape on the axis */
  readonly half: number;
}

export interface Frame {
  readonly variables: readonly ColaVariable[];
  /** start and end of the pool on the axis, none for the frames of a whole plane */
  readonly outer?: readonly [ColaVariable, ColaVariable];
  readonly constraints: readonly ColaConstraint[];
  /** positions and extents of the pools and lanes on the axis after solving */
  readonly spans: () => Map<string, readonly [number, number]>;
}

interface Pool {
  readonly shape: DiagramShape;
  /** every lane of the pool, nested ones included */
  readonly lanes: readonly DiagramShape[];
}

function poolsOf(shapes: readonly DiagramShape[]): Pool[] {
  return shapes
    .filter((shape) => shape.type === "Participant")
    .map((shape) => ({ shape, lanes: shapes.filter((lane) => lane.type === "Lane" && lane.pool === shape.id) }));
}

function end(bounds: Rect, axis: Axis): number {
  return axis === "x" ? bounds.x + bounds.width : bounds.y + bounds.height;
}

type Band = readonly [ColaVariable, ColaVariable];

/** Collects the solver variables and constraints of one pool on one axis. */
class FrameBuilder {
  readonly variables: ColaVariable[] = [];
  readonly constraints: ColaConstraint[] = [];
  /** the band of every lane (and of the pool) between its two border variables */
  readonly bands = new Map<string, Band>();

  border(position: number): ColaVariable {
    const variable = new Variable(position);
    this.variables.push(variable);
    return variable;
  }

  atLeast(left: ColaVariable, right: ColaVariable, gap: number): void {
    this.constraints.push(new Constraint(left, right, gap));
  }
}

/**
 * The lanes nested in one band, top to bottom: their borders lie in the band, each lane at least MIN_BAND high; the
 * lanes nested in them follow recursively. On x every lane spans the band of its pool.
 */
function laneBands(
  builder: FrameBuilder,
  lanes: readonly DiagramShape[],
  parent: string | undefined,
  band: Band,
): void {
  const children = lanes
    .filter((lane) => lane.lane === parent)
    .sort((first, second) => first.bounds.y - second.bounds.y);
  let top = band[0];
  children.forEach((lane, index) => {
    const bottom = index === children.length - 1 ? band[1] : builder.border(end(lane.bounds, "y"));
    builder.atLeast(top, bottom, MIN_BAND);
    builder.bands.set(lane.id, [top, bottom]);
    laneBands(builder, lanes, lane.id, [top, bottom]);
    top = bottom;
  });
}

/** Start padding on x: the name strips of the pool and of the lanes the node is nested in. */
function leading(pool: Pool, member: DiagramShape, axis: Axis): number {
  if (axis === "y") {
    return PADDING;
  }
  const lane = pool.lanes.find((candidate) => candidate.id === member.lane);
  return (lane ? lane.bounds.x - pool.shape.bounds.x : POOL_HEADER) + PADDING;
}

/** Start and extent of a band after solving. */
function span([start, stop]: Band): readonly [number, number] {
  const from = Math.round(start.position());
  return [from, Math.round(stop.position()) - from];
}

/** Positions and extents of the pool and its lanes on the axis; on x every lane keeps its offset in the pool. */
function spansOf(pool: Pool, axis: Axis, bands: ReadonlyMap<string, Band>): Map<string, readonly [number, number]> {
  const outer = bands.get(pool.shape.id);
  if (!outer) {
    return new Map();
  }
  const [first, extent] = span(outer);
  const result = new Map<string, readonly [number, number]>([[pool.shape.id, [first, extent]]]);
  for (const lane of pool.lanes) {
    const offset = lane.bounds.x - pool.shape.bounds.x;
    const band = bands.get(lane.id);
    if (axis === "x") {
      result.set(lane.id, [first + offset, extent - offset]);
    } else if (band) {
      result.set(lane.id, span(band));
    }
  }
  return result;
}

function poolFrame(pool: Pool, axis: Axis, members: readonly Placed[]): Frame {
  const builder = new FrameBuilder();
  const outer: Band = [builder.border(pool.shape.bounds[axis]), builder.border(end(pool.shape.bounds, axis))];
  builder.atLeast(outer[0], outer[1], MIN_BAND);
  builder.bands.set(pool.shape.id, outer);
  if (axis === "y") {
    laneBands(builder, pool.lanes, undefined, outer);
  }
  for (const member of members) {
    const [start, stop] = (axis === "y" ? builder.bands.get(member.shape.lane ?? "") : undefined) ?? outer;
    builder.atLeast(start, member.variable, leading(pool, member.shape, axis) + member.half);
    builder.atLeast(member.variable, stop, member.half + PADDING);
  }
  const spans = (): Map<string, readonly [number, number]> => spansOf(pool, axis, builder.bands);
  return { variables: builder.variables, outer, constraints: builder.constraints, spans };
}

/** Free space above the content of an expanded sub-process, for its name. */
const SUB_PROCESS_HEADER = 30;

/** An expanded sub-process as the frame of its content: its four borders, 20 px padding, room for its name on top. */
export function subProcessFrame(sub: DiagramShape, members: readonly Placed[], axis: Axis): Frame {
  const builder = new FrameBuilder();
  const outer: Band = [builder.border(sub.bounds[axis]), builder.border(end(sub.bounds, axis))];
  builder.atLeast(outer[0], outer[1], MIN_BAND);
  const leadingPadding = axis === "y" ? SUB_PROCESS_HEADER : PADDING;
  for (const member of members) {
    builder.atLeast(outer[0], member.variable, leadingPadding + member.half);
    builder.atLeast(member.variable, outer[1], member.half + PADDING);
  }
  return {
    variables: builder.variables,
    outer,
    constraints: builder.constraints,
    spans: () => new Map([[sub.id, span(outer)]]),
  };
}

/** Pools on top of each other keep their order and at most their current distance, up to the minimum gap. */
function stacking(pools: readonly Pool[], frames: readonly Frame[]): ColaConstraint[] {
  const order = pools.map((pool, index) => ({ pool, frame: frames[index] }));
  order.sort((first, second) => first.pool.shape.bounds.y - second.pool.shape.bounds.y);
  return order.slice(1).flatMap(({ pool, frame }, index) => {
    const above = order[index];
    const bottom = above?.frame?.outer?.[1];
    const top = frame?.outer?.[0];
    if (!above || !bottom || !top) {
      return [];
    }
    const distance = pool.shape.bounds.y - end(above.pool.shape.bounds, "y");
    return [new Constraint(bottom, top, Math.max(0, Math.min(distance, MIN_SHAPE_GAP)))];
  });
}

/** The frames of all pools of a plane on one axis; none when the plane has no pool. */
export function framesFor(shapes: readonly DiagramShape[], placed: readonly Placed[], axis: Axis): Frame {
  const pools = poolsOf(shapes);
  const frames = pools.map((pool) =>
    poolFrame(
      pool,
      axis,
      placed.filter((member) => member.shape.pool === pool.shape.id),
    ),
  );
  return {
    variables: frames.flatMap((frame) => frame.variables),
    constraints: [...frames.flatMap((frame) => frame.constraints), ...(axis === "y" ? stacking(pools, frames) : [])],
    spans: () => new Map(frames.flatMap((frame) => [...frame.spans()])),
  };
}
