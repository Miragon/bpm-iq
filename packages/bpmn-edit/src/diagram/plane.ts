/** The DI of one diagram plane as plain data: what the metrics (and later the layout) work on. */
import type { Point, Rect } from "../geometry/geometry.ts";

export interface DiagramShape {
  readonly id: string;
  /** semantic type without prefix, e.g. 'ServiceTask', 'ExclusiveGateway' */
  readonly type: string;
  readonly bounds: Rect;
  /** external label bounds, only for named elements whose DI carries them */
  readonly label?: Rect;
  /** the text of the external label: the name of the element, only when it has a label */
  readonly name?: string;
  /** host activity of a boundary event */
  readonly attachedTo?: string;
  /** pools, lanes, groups and expanded sub-processes: they contain other shapes and are no obstacles */
  readonly container: boolean;
  /** the innermost lane of a flow node (for a nested lane: the lane it is nested in) */
  readonly lane?: string;
  /** the participant (pool) whose process holds the element (for a lane: its pool) */
  readonly pool?: string;
  /** the expanded sub-process drawn on the same plane that holds the flow node directly */
  readonly parent?: string;
}

export interface DiagramEdge {
  readonly id: string;
  readonly type: string;
  readonly source?: string;
  readonly target?: string;
  readonly waypoints: readonly Point[];
  readonly label?: Rect;
  /** the text of the external label: the name of the flow, only when it has a label */
  readonly name?: string;
}

export interface DiagramPlane {
  /** id of the element the plane shows: the process, a collaboration or a collapsed sub-process */
  readonly id: string;
  readonly shapes: readonly DiagramShape[];
  readonly edges: readonly DiagramEdge[];
}

/** Connections the metrics treat as flow; associations and data associations are left out. */
export const FLOW_EDGE_TYPES: ReadonlySet<string> = new Set(["SequenceFlow", "MessageFlow"]);

/** The level a flow node is laid out on: its expanded sub-process, else its pool, else the plane (''). */
export function levelOf(shape: DiagramShape): string {
  return shape.parent ?? shape.pool ?? "";
}

/** The innermost frame of a flow node: its expanded sub-process, else its lane, else its pool, else none (''). */
export function frameOf(shape: DiagramShape): string {
  return shape.parent ?? shape.lane ?? shape.pool ?? "";
}
