/**
 * The flows of a globally laid out plane: the routes of the old drawing are dropped first, so no flow avoids the
 * ghost of another one; the loop returns take their channels; then every other flow is routed, seeing the loops and
 * the flows routed before it, and those that end up on top of another flow are routed once more. Last, every flow in
 * a crossing gets one more route, which is kept only when the plane has fewer crossings with it. A branch routed while
 * it was alone on the right side of its gateway forks anew once its siblings share that side.
 */
import { type DiagramPlane, FLOW_EDGE_TYPES } from "../../diagram/plane.ts";
import { crossingFlows, overlappingFlows } from "../../metrics/edges.ts";
import { measurePlane } from "../../metrics/metrics.ts";
import { reroute } from "../reroute.ts";
import { lateForks } from "../router/branches.ts";
import { loopIds, routeLoops } from "./loops.ts";

/** How often the flows in crossings are tried once more; a pass without improvement stops earlier. */
const UNTANGLE_PASSES = 2;

function withoutRoutes(plane: DiagramPlane): DiagramPlane {
  return {
    ...plane,
    edges: plane.edges.map((edge) => (FLOW_EDGE_TYPES.has(edge.type) ? { ...edge, waypoints: [] } : edge)),
  };
}

function untangle(plane: DiagramPlane, fixed: ReadonlySet<string>): DiagramPlane {
  let current = plane;
  let crossings = measurePlane(current).edgeCrossings;
  for (let pass = 0, improved = true; pass < UNTANGLE_PASSES && improved && crossings > 0; pass++) {
    improved = false;
    for (const id of [...crossingFlows(current)].filter((candidate) => !fixed.has(candidate))) {
      const candidate = reroute(current, new Set([id]));
      const fewer = measurePlane(candidate).edgeCrossings;
      if (fewer < crossings) {
        [current, crossings, improved] = [candidate, fewer, true];
      }
    }
  }
  return current;
}

export function routeFlows(plane: DiagramPlane): DiagramPlane {
  const looped = routeLoops(withoutRoutes(plane));
  const loops = loopIds(looped);
  const others = new Set(
    looped.edges.filter((edge) => FLOW_EDGE_TYPES.has(edge.type) && !loops.has(edge.id)).map((edge) => edge.id),
  );
  const routed = reroute(looped, others);
  const again = new Set([...overlappingFlows(routed)].filter((id) => others.has(id)));
  const settled = reroute(routed, again);
  return untangle(reroute(settled, lateForks(settled)), loops);
}
