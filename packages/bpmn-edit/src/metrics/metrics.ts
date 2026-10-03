/** Layout metrics per diagram plane: a deterministic quality measure that complements lint and rendering. */
import type { DiagramPlane } from "../diagram/plane.ts";
import { readPlanes } from "../diagram/reader.ts";
import { boundingBox } from "../geometry/geometry.ts";
import {
  countBackward,
  countBends,
  countCrossings,
  countOverlaps,
  countThroughShape,
  flowPaths,
  totalLength,
} from "./edges.ts";
import { countLabelOverlaps, labelsOf } from "./labels.ts";
import { countEndEventsOffColumn, countOutsideFrames, countWrongSides } from "./rules.ts";
import { countShapeProblems } from "./shapes.ts";

export interface PlaneMetrics {
  readonly plane: string;
  readonly shapes: number;
  readonly edges: number;
  readonly labels: number;
  readonly shapeOverlaps: number;
  readonly shapeGapViolations: number;
  readonly labelOverlaps: number;
  readonly edgeCrossings: number;
  readonly edgeOverlaps: number;
  readonly edgeThroughShape: number;
  readonly bends: number;
  readonly edgeLength: number;
  readonly backwardEdges: number;
  readonly wrongSideFlows: number;
  readonly endEventsOffColumn: number;
  readonly outsideFrames: number;
  readonly width: number;
  readonly height: number;
}

function extent(plane: DiagramPlane): { width: number; height: number } {
  const rects = plane.shapes.flatMap((shape) => (shape.label ? [shape.bounds, shape.label] : [shape.bounds]));
  const labels = plane.edges.flatMap((edge) => (edge.label ? [edge.label] : []));
  const box = boundingBox(
    [...rects, ...labels],
    plane.edges.flatMap((edge) => edge.waypoints),
  );
  return { width: Math.round(box?.width ?? 0), height: Math.round(box?.height ?? 0) };
}

export function measurePlane(plane: DiagramPlane): PlaneMetrics {
  const paths = flowPaths(plane);
  const shapeProblems = countShapeProblems(plane.shapes);
  return {
    plane: plane.id,
    shapes: plane.shapes.length,
    edges: paths.length,
    labels: labelsOf(plane).length,
    shapeOverlaps: shapeProblems.overlaps,
    shapeGapViolations: shapeProblems.gapViolations,
    labelOverlaps: countLabelOverlaps(plane, paths),
    edgeCrossings: countCrossings(paths),
    edgeOverlaps: countOverlaps(paths),
    edgeThroughShape: countThroughShape(paths, plane.shapes),
    bends: countBends(paths),
    edgeLength: Math.round(totalLength(paths)),
    backwardEdges: countBackward(paths),
    wrongSideFlows: countWrongSides(plane),
    endEventsOffColumn: countEndEventsOffColumn(plane),
    outsideFrames: countOutsideFrames(plane),
    ...extent(plane),
  };
}

export async function measure(xml: string, source: string): Promise<PlaneMetrics[]> {
  return (await readPlanes(xml, source)).map(measurePlane);
}
