/** Formats plane metrics as a plain text table, one row per plane. */
import type { PlaneMetrics } from "./metrics.ts";

type NumericKey = Exclude<keyof PlaneMetrics, "plane">;

const COLUMNS: readonly (readonly [NumericKey, string])[] = [
  ["shapes", "shapes"],
  ["edges", "edges"],
  ["labels", "labels"],
  ["shapeOverlaps", "shpOvl"],
  ["shapeGapViolations", "gap<20"],
  ["labelOverlaps", "lblOvl"],
  ["edgeCrossings", "cross"],
  ["edgeOverlaps", "edgOvl"],
  ["edgeThroughShape", "through"],
  ["bends", "bends"],
  ["edgeLength", "length"],
  ["backwardEdges", "back"],
  ["wrongSideFlows", "side"],
  ["endEventsOffColumn", "endCol"],
  ["outsideFrames", "outLane"],
  ["width", "width"],
  ["height", "height"],
];

const LEGEND = [
  "shpOvl: overlapping shape pairs, gap<20: shape pairs closer than 20 px, lblOvl: labels covering a shape,",
  "flow or label, cross: crossing flow pairs, edgOvl: flow pairs on top of each other, through: flows through",
  "a foreign shape, back: sequence flows ending left of their start, side: flows leaving their source on a wrong",
  "side (an activity elsewhere than right, a gateway to the left), endCol: end events not in the one column on the right, outLane: flow",
  "nodes outside their lane or pool,",
  "length/width/height in px",
];

function row(cells: readonly string[], widths: readonly number[]): string {
  return cells
    .map((cell, index) => (index === 0 ? cell.padEnd(widths[index] ?? 0) : cell.padStart(widths[index] ?? 0)))
    .join("  ")
    .trimEnd();
}

export function formatTable(metrics: readonly PlaneMetrics[]): string[] {
  const header = ["plane", ...COLUMNS.map(([, title]) => title)];
  const rows = metrics.map((plane) => [plane.plane, ...COLUMNS.map(([key]) => String(plane[key]))]);
  const widths = header.map((title, index) =>
    Math.max(title.length, ...rows.map((cells) => cells[index]?.length ?? 0)),
  );
  return [row(header, widths), ...rows.map((cells) => row(cells, widths)), "", ...LEGEND];
}
