/** Text output of the commands that change a document: what changed and the metrics before and after. */
import type { PlaneMetrics } from "../metrics/metrics.ts";

type Compared = Exclude<keyof PlaneMetrics, "plane">;

const COMPARED: readonly Compared[] = [
  "shapeOverlaps",
  "shapeGapViolations",
  "labelOverlaps",
  "edgeCrossings",
  "edgeOverlaps",
  "edgeThroughShape",
  "bends",
  "edgeLength",
  "backwardEdges",
  "width",
  "height",
];

/** One line per plane with every metric that changed, `name before->after`; unchanged planes say so. */
function formatComparison(before: readonly PlaneMetrics[], after: readonly PlaneMetrics[]): string[] {
  return after.map((metrics) => {
    const old = before.find((candidate) => candidate.plane === metrics.plane);
    const changes = COMPARED.filter((key) => old && old[key] !== metrics[key]).map(
      (key) => `${key} ${old?.[key] ?? ""}->${metrics[key]}`,
    );
    return `  ${metrics.plane}: ${changes.length > 0 ? changes.join(", ") : "metrics unchanged"}`;
  });
}

export interface ChangeSummary {
  readonly file: string;
  readonly written: boolean;
  readonly lists: readonly (readonly [string, readonly string[]])[];
  readonly diagnostics: readonly string[];
  readonly before: readonly PlaneMetrics[];
  readonly after: readonly PlaneMetrics[];
}

export function formatSummary(summary: ChangeSummary): string[] {
  return [
    `[bpmn-edit] ${summary.file}: ${summary.written ? "written" : "dry run, nothing written"}`,
    ...summary.lists.map(([title, ids]) => `${title} (${ids.length}): ${ids.join(", ") || "-"}`),
    ...summary.diagnostics.map((message) => `note: ${message}`),
    "metrics per plane:",
    ...formatComparison(summary.before, summary.after),
  ];
}
