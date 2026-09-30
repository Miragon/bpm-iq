/** Re-routes flows and places the labels of everything a layout step touched. */
import { type DiagramPlane, FLOW_EDGE_TYPES } from "../diagram/plane.ts";
import {
  boxesMeet,
  boxOf,
  EPSILON,
  type Point,
  type Rect,
  rectsOverlap,
  segmentCrossesRect,
  segmentsOf,
} from "../geometry/geometry.ts";
import { overlappingFlows } from "../metrics/edges.ts";
import { measurePlane } from "../metrics/metrics.ts";
import { wrongSideFlows } from "../metrics/rules.ts";
import { distantLabels, placeLabels } from "./labels.ts";
import { directConnection, routeEdge } from "./router/router.ts";
import { withinHardLimits } from "./score.ts";
import { endsOf } from "./space.ts";
import { stretchFlows } from "./stretch.ts";

/** Flows with a moved end, and flows that now run through a shape they do not connect. */
export function affectedEdges(plane: DiagramPlane, moved: ReadonlySet<string>): Set<string> {
  const blocking = plane.shapes.filter((shape) => !shape.container);
  return new Set(
    plane.edges
      .filter((edge) => FLOW_EDGE_TYPES.has(edge.type))
      .filter((edge) => {
        if (moved.has(edge.source ?? "") || moved.has(edge.target ?? "")) return true;
        const ends = endsOf(plane, edge);
        const box = boxOf(edge.waypoints);
        const segments = segmentsOf(edge.waypoints);
        return blocking.some(
          (shape) =>
            !ends.has(shape.id) &&
            boxesMeet(box, shape.bounds) &&
            segments.some((segment) => segmentCrossesRect(segment, shape.bounds)),
        );
      })
      .map((edge) => edge.id),
  );
}

/**
 * Routes the given flows anew one after the other, each seeing the routes before it; a flow without a route keeps
 * its waypoints.
 */
export function reroute(plane: DiagramPlane, edgeIds: ReadonlySet<string>): DiagramPlane {
  return plane.edges
    .filter((edge) => edgeIds.has(edge.id))
    .reduce((current, edge) => {
      const waypoints = routeEdge(current, edge);
      return waypoints
        ? { ...current, edges: current.edges.map((other) => (other.id === edge.id ? { ...other, waypoints } : other)) }
        : current;
    }, plane);
}

/** How far a flow end may lie from the border of its shape and still count as attached. */
const ATTACH_TOLERANCE = 2;

function attached(point: Point | undefined, shape: Rect | undefined): boolean {
  return (
    !point ||
    !shape ||
    (point.x >= shape.x - ATTACH_TOLERANCE &&
      point.x <= shape.x + shape.width + ATTACH_TOLERANCE &&
      point.y >= shape.y - ATTACH_TOLERANCE &&
      point.y <= shape.y + shape.height + ATTACH_TOLERANCE)
  );
}

/** Flows with an end away from its shape or a segment that is not orthogonal. */
export function brokenEdges(plane: DiagramPlane): Set<string> {
  const bounds = new Map(plane.shapes.map((shape) => [shape.id, shape.bounds]));
  return new Set(
    plane.edges
      .filter((edge) => FLOW_EDGE_TYPES.has(edge.type))
      .filter((edge) => {
        const loose =
          !attached(edge.waypoints[0], bounds.get(edge.source ?? "")) ||
          !attached(edge.waypoints.at(-1), bounds.get(edge.target ?? ""));
        const diagonal = segmentsOf(edge.waypoints).some(
          ([start, end]) => Math.abs(start.x - end.x) >= EPSILON && Math.abs(start.y - end.y) >= EPSILON,
        );
        return loose || diagonal;
      })
      .map((edge) => edge.id),
  );
}

/**
 * Safety net after a layout step: every flow that is broken now but was not broken before gets a new route, so no
 * step leaves a loose end or a diagonal behind (flows the author drew that way stay as they are).
 */
export function repairBroken(before: DiagramPlane, after: DiagramPlane): DiagramPlane {
  const known = brokenEdges(before);
  const broken = new Set([...brokenEdges(after)].filter((id) => !known.has(id)));
  if (broken.size === 0) {
    return after;
  }
  const rerouted = reroute(after, broken);
  const bounds = new Map(rerouted.shapes.map((shape) => [shape.id, shape.bounds]));
  const still = brokenEdges(rerouted);
  const connected: DiagramPlane = {
    ...rerouted,
    edges: rerouted.edges.map((edge) => {
      const source = bounds.get(edge.source ?? "");
      const target = bounds.get(edge.target ?? "");
      return broken.has(edge.id) && still.has(edge.id) && source && target
        ? { ...edge, waypoints: directConnection(source, target) }
        : edge;
    }),
  };
  return relabel(connected, broken);
}

/** Labels of moved shapes and re-routed flows, every label that covers a shape and every label far from its element. */
export function relabel(plane: DiagramPlane, touched: ReadonlySet<string>): DiagramPlane {
  const blocking = plane.shapes.filter((shape) => !shape.container);
  const covering = [...plane.shapes, ...plane.edges]
    .filter(
      (element) =>
        element.label &&
        blocking.some((shape) => shape.id !== element.id && element.label && rectsOverlap(element.label, shape.bounds)),
    )
    .map((element) => element.id);
  return placeLabels(plane, new Set([...touched, ...covering, ...distantLabels(plane)]));
}

/**
 * Re-routes the flows affected by the moved shapes, then places the labels of everything touched. The flows are
 * routed one after the other, so an early flow saw the later ones at their old places; those of them that now run on
 * top of another flow are routed once more.
 */
export function settle(plane: DiagramPlane, moved: ReadonlySet<string>): DiagramPlane {
  const edges = affectedEdges(plane, moved);
  const routed = reroute(plane, edges);
  const again = new Set([...overlappingFlows(routed)].filter((id) => edges.has(id)));
  return relabel(reroute(routed, again), new Set([...moved, ...edges]));
}

/**
 * For shapes that only gave way (tidy, separation): their flows stretch instead of being routed anew; a flow is
 * routed only when stretching fails or it runs through a shape. Then the labels of everything touched are placed.
 */
export function settleShifted(before: DiagramPlane, after: DiagramPlane, moved: ReadonlySet<string>): DiagramPlane {
  const stretched = stretchFlows(before, after, moved);
  const routes = new Set([...stretched.unresolved, ...affectedEdges(stretched.plane, new Set())]);
  return relabel(reroute(stretched.plane, routes), new Set([...moved, ...routes]));
}

/**
 * Routes the flows that leave their source on a wrong side anew, one at a time. A new route is kept only when it adds
 * no crossing, no shape overlap and no flow through a shape; otherwise the flow keeps its way.
 */
export function fixSides(plane: DiagramPlane): { plane: DiagramPlane; rerouted: Set<string> } {
  const rerouted = new Set<string>();
  const fixed = wrongSideFlows(plane).reduce((current, edge) => {
    const candidate = reroute(current, new Set([edge.id]));
    if (candidate === current || !withinHardLimits(candidate, measurePlane(current))) {
      return current;
    }
    rerouted.add(edge.id);
    return candidate;
  }, plane);
  return { plane: relabel(fixed, rerouted), rerouted };
}
