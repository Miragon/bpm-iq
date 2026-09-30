/**
 * The branches of a split (layout-geometry.md): no two flows leave one shape by the same top or bottom side, further
 * branches share the right side as a trunk and fork from it. The forward branches of a gateway or event a loop
 * returns from, and of a gateway with three branches or more, all leave to the right, so every way on is seen in one
 * place. A branch of a gateway into another row forks right behind it, so every way on is seen right at the gateway.
 */
import { type DiagramEdge, type DiagramPlane, type DiagramShape, FLOW_EDGE_TYPES } from "../../diagram/plane.ts";
import { EPSILON, type Point } from "../../geometry/geometry.ts";
import { runsBack } from "../../metrics/edges.ts";
import { kindOf, ROUTE_MARGIN } from "../constants.ts";
import { center, shapesById } from "../space.ts";
import { DOWN, type Port, RIGHT, sourcePorts, UP } from "./ports.ts";

/** From this number of forward branches on, a gateway leaves them all to the right. */
const FAN_BRANCHES = 3;

/** The routed flows leaving the source of `edge`, the edge itself left out. */
function siblingsOf(plane: DiagramPlane, edge: DiagramEdge): DiagramEdge[] {
  return plane.edges.filter(
    (other) =>
      other.id !== edge.id &&
      FLOW_EDGE_TYPES.has(other.type) &&
      other.source === edge.source &&
      other.waypoints.length > 1,
  );
}

/** The ids of the routed forward branches of the source of `edge`: they may share its trunk. */
export function branchIds(plane: DiagramPlane, edge: DiagramEdge): Set<string> {
  return new Set(
    siblingsOf(plane, edge)
      .filter((other) => !runsBack(other))
      .map((other) => other.id),
  );
}

/** Whether the forward branches of the source all leave to the right: a loop returns from it, or it fans out wide. */
function rightOnly(plane: DiagramPlane, source: DiagramShape): boolean {
  const byId = shapesById(plane);
  const targets = plane.edges
    .filter((other) => FLOW_EDGE_TYPES.has(other.type) && other.source === source.id)
    .flatMap((other) => byId.get(other.target ?? "") ?? []);
  const back = targets.filter((target) => center(target.bounds).x < center(source.bounds).x).length;
  const kind = kindOf(source.type);
  return (back > 0 && kind !== "activity") || (kind === "gateway" && targets.length - back >= FAN_BRANCHES);
}

/** The sides the flow may leave its source by, in order of preference. */
export function freePorts(plane: DiagramPlane, source: DiagramShape, edge: DiagramEdge): Port[] {
  const only = rightOnly(plane, source) && !runsBack(edge);
  const ports = sourcePorts(source);
  const free = ports.filter((port) => port.direction === RIGHT || (!only && !shared(plane, edge, port.point)));
  return free.length > 0 ? free : ports;
}

/** Whether a routed sibling of `edge` already starts at `point`: the flow would share its trunk. */
function shared(plane: DiagramPlane, edge: DiagramEdge, point: Point): boolean {
  return siblingsOf(plane, edge).some((other) => {
    const start = other.waypoints[0];
    return start !== undefined && Math.abs(start.x - point.x) < EPSILON && Math.abs(start.y - point.y) < EPSILON;
  });
}

/**
 * The candidates of a flow with every one that would share the right side of its gateway with another branch and
 * turns into another row turned into a fork: the route runs ROUTE_MARGIN to the right and turns there towards the
 * row of its target, so every way on is seen right at the gateway. A branch alone on the right side runs straight on
 * and turns at its target, with the fewest bends. The same candidates for any other flow.
 */
export function withForks<C extends { readonly from: Port; readonly to: Port }>(
  plane: DiagramPlane,
  edge: DiagramEdge,
  candidates: readonly C[],
): (C & { readonly lead?: Point })[] {
  const byId = shapesById(plane);
  const [source, target] = [byId.get(edge.source ?? ""), byId.get(edge.target ?? "")];
  if (!source || !target || kindOf(source.type) !== "gateway") {
    return [...candidates];
  }
  const row = target.bounds.y + target.bounds.height / 2;
  return candidates.map((candidate) => {
    const { point, direction } = candidate.from;
    if (direction !== RIGHT || Math.abs(row - point.y) < EPSILON || !shared(plane, edge, point)) {
      return candidate;
    }
    const fork = { x: point.x + ROUTE_MARGIN, y: point.y };
    return { ...candidate, lead: point, from: { point: fork, direction: row < point.y ? UP : DOWN } };
  });
}

/** Farthest a branch sharing the right side of its gateway may run on before it turns off the trunk. */
const FORK_REACH = 50;

/**
 * Branches that share the right side of their gateway with another branch but turn off the trunk farther than
 * FORK_REACH behind it: routed while they were alone on that side, they fork anew once all branches are there.
 */
export function lateForks(plane: DiagramPlane): Set<string> {
  const byId = shapesById(plane);
  return new Set(
    plane.edges
      .filter((edge) => {
        const source = byId.get(edge.source ?? "");
        const [start, turn, after] = edge.waypoints;
        const leavesRight = source && start && Math.abs(start.x - (source.bounds.x + source.bounds.width)) < EPSILON;
        return (
          leavesRight &&
          kindOf(source.type) === "gateway" &&
          turn &&
          after &&
          turn.y === start.y &&
          turn.x - start.x > FORK_REACH &&
          shared(plane, edge, start)
        );
      })
      .map((edge) => edge.id),
  );
}
