/**
 * Sizes and distances of the layout: the geometry of the Camunda Modeler (task 100x80, events 36, gateways 50) and
 * of hand-made diagrams, so that a computed layout looks like a hand-made one.
 */
export { MIN_STUB } from "../metrics/edges.ts";
export { MIN_SHAPE_GAP } from "../metrics/shapes.ts";

/** Free space between two columns: tasks 200 px apart centre to centre, 100 px wide. */
export const COLUMN_GAP = 100;
/** Centre to centre distance of two rows. */
export const ROW_SPACING = 150;
/**
 * Distance a route keeps from shapes it passes, so a line along a row stays visibly apart from it; also the straight
 * stub at both ends of a flow, which the rule flow-connection-side wants to be at least 20 px long.
 */
export const ROUTE_MARGIN = 30;
/** Cost of one bend in px of route length: a route may be this much longer to save a bend. */
export const BEND_PENALTY = 150;
/** Cost of crossing another flow, in px of route length. */
export const CROSSING_PENALTY = 200;
/** Cost of running on top of another flow for one grid step, in px of route length. */
export const OVERLAP_PENALTY = 300;
/** Offset of a boundary event from the bottom right corner of its host (layout-geometry.md). */
export const BOUNDARY_FROM_RIGHT = 28;
export const BOUNDARY_FROM_BOTTOM = 18;
/** Advance of one character of the external label font (11 px Arial) as bpmn-js measures it, a little above its average. */
export const LABEL_CHAR_WIDTH = 6;
/** Height of one line of the external label font. */
export const LABEL_LINE_HEIGHT = 14;
/** Distance of the external label of a shape from the shape: close, so it visibly belongs to it. */
export const SHAPE_LABEL_DISTANCE = 4;
/** Distance of an external label from its flow. */
export const LABEL_DISTANCE = 8;
/** Free space an external label keeps to every foreign shape, flow and label. */
export const LABEL_CLEARANCE = 8;

export type Kind = "event" | "gateway" | "activity" | "other";

export interface Size {
  readonly width: number;
  readonly height: number;
}

export const SIZES: Readonly<Record<Kind, Size>> = {
  event: { width: 36, height: 36 },
  gateway: { width: 50, height: 50 },
  activity: { width: 100, height: 80 },
  other: { width: 100, height: 80 },
};

const ACTIVITY = /Task$|^SubProcess$|^AdHocSubProcess$|^Transaction$|^CallActivity$/;

/** The kind of a BPMN type without prefix ('ServiceTask', 'ExclusiveGateway', 'BoundaryEvent', ...). */
export function kindOf(type: string): Kind {
  if (type.endsWith("Event")) {
    return "event";
  }
  if (type.endsWith("Gateway")) {
    return "gateway";
  }
  return ACTIVITY.test(type) ? "activity" : "other";
}
