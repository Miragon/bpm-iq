/**
 * Which layout variant is taken. A variant must not add crossings, shape overlaps or flows through shapes (hard
 * limits, whatever its score), and it must beat the reference by score. For relayout the reference is the plane with
 * only its covering labels placed anew, so label fixes alone do not count as merit of a new layout; when that
 * label-only plane is the best, only the labels change.
 */
import type { DiagramPlane } from "../diagram/plane.ts";
import { measurePlane } from "../metrics/metrics.ts";
import type { LayoutMode } from "./layout.ts";
import type { Variant } from "./relayout/relayout.ts";
import { relabel, repairBroken } from "./reroute.ts";
import type { LayoutDiagnostic } from "./result.ts";
import { score, withinHardLimits } from "./score.ts";

export interface Chosen {
  readonly after: DiagramPlane;
  readonly moved: ReadonlySet<string>;
  readonly diagnostics: readonly LayoutDiagnostic[];
}

function best(variants: readonly Variant[]): { variant: Variant; score: number } | undefined {
  return variants
    .map((variant) => ({ variant, score: score(variant.plane) }))
    .reduce<{ variant: Variant; score: number } | undefined>(
      (winner, candidate) => (!winner || candidate.score < winner.score ? candidate : winner),
      undefined,
    );
}

/**
 * A global layout was asked for explicitly: it replaces the plane; a note says so when it is worse than the drawing
 * before on a hard limit.
 */
function takeLayout(plane: DiagramPlane, variant: Variant): Chosen {
  const after = repairBroken(plane, variant.plane);
  const worse = !withinHardLimits(after, measurePlane(plane));
  const diagnostics = worse
    ? [
        {
          message: `layout of plane '${plane.id}' has more overlaps, nodes outside their frame, flows through shapes or crossings than before`,
        },
      ]
    : [];
  return { after, moved: variant.moved, diagnostics };
}

export function choose(plane: DiagramPlane, proposed: readonly Variant[], mode: LayoutMode): Chosen {
  const [layout] = proposed;
  return mode === "layout" && layout ? takeLayout(plane, layout) : chooseVariant(plane, proposed, mode);
}

/** The best variant of a tidy or relayout within the hard limits, or the plane as it is (see the file comment). */
function chooseVariant(plane: DiagramPlane, proposed: readonly Variant[], mode: LayoutMode): Chosen {
  const variants = proposed.map((variant) => ({ ...variant, plane: repairBroken(plane, variant.plane) }));
  const original = { variant: { plane, moved: new Set<string>() }, score: score(plane) };
  const labelsOnly = mode === "relayout" ? best([{ plane: relabel(plane, new Set()), moved: new Set() }]) : undefined;
  const reference = labelsOnly && labelsOnly.score < original.score ? labelsOnly : original;
  const originalMetrics = measurePlane(plane);
  const winner = best(variants.filter((variant) => withinHardLimits(variant.plane, originalMetrics)));
  if (winner && winner.score < reference.score) {
    return { after: winner.variant.plane, moved: winner.variant.moved, diagnostics: [] };
  }
  const reason = `${mode} would not improve plane '${plane.id}' (score ${Math.round(winner?.score ?? original.score)} against ${Math.round(reference.score)}, or it would add crossings, overlaps or flows through shapes)`;
  if (reference !== original) {
    return {
      after: reference.variant.plane,
      moved: new Set(),
      diagnostics: [{ message: `${reason}; only covering labels placed anew` }],
    };
  }
  return { after: plane, moved: new Set(), diagnostics: [{ message: `${reason}; left as it is` }] };
}
