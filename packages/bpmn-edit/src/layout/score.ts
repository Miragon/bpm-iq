/**
 * One number for the layout quality of a plane, lower is better: the metrics weighted by how much they hurt a
 * reader. A layout step is only taken when it lowers the score of its plane.
 */
import type { DiagramPlane } from "../diagram/plane.ts";
import { measurePlane, type PlaneMetrics } from "../metrics/metrics.ts";

type Weighted = Exclude<keyof PlaneMetrics, "plane" | "shapes" | "edges" | "labels" | "width" | "height">;

/**
 * Weight per unit of each metric, in the currency of one bend. A flow against the reading direction (left to right)
 * weighs almost as much as a crossing: a layout that turns such flows around is worth longer and bent flows.
 */
const WEIGHTS: Readonly<Record<Weighted, number>> = {
  shapeOverlaps: 1000,
  outsideFrames: 1000,
  edgeThroughShape: 500,
  edgeCrossings: 200,
  backwardEdges: 150,
  edgeOverlaps: 100,
  wrongSideFlows: 100,
  endEventsOffColumn: 100,
  labelOverlaps: 50,
  shapeGapViolations: 50,
  bends: 10,
  edgeLength: 0.01,
};
const WEIGHTED: readonly Weighted[] = [
  "shapeOverlaps",
  "outsideFrames",
  "edgeThroughShape",
  "edgeCrossings",
  "backwardEdges",
  "edgeOverlaps",
  "wrongSideFlows",
  "endEventsOffColumn",
  "labelOverlaps",
  "shapeGapViolations",
  "bends",
  "edgeLength",
];

export function score(plane: DiagramPlane): number {
  const metrics = measurePlane(plane);
  return WEIGHTED.reduce((sum, key) => sum + metrics[key] * WEIGHTS[key], 0);
}

type Hard = "shapeOverlaps" | "outsideFrames" | "edgeThroughShape" | "edgeCrossings";
/** The hard limits from the most to the least severe defect. */
const HARD_LIMITS: readonly Hard[] = ["shapeOverlaps", "outsideFrames", "edgeThroughShape", "edgeCrossings"];

/**
 * True when the plane adds no shape overlap, no flow node outside its lane or pool, no flow through a shape and no
 * crossing to the original metrics, compared from the most severe defect down: a step may add a lighter defect only
 * when it removes a more severe one (a crossing to take a shape out of an overlap), never on a clean layout.
 */
export function withinHardLimits(plane: DiagramPlane, original: PlaneMetrics): boolean {
  const metrics = measurePlane(plane);
  const decisive = HARD_LIMITS.find((key) => metrics[key] !== original[key]);
  return decisive === undefined || metrics[decisive] < original[decisive];
}
