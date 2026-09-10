/**
 * Element-level diff of two ModelGraphs — which elements a save touched.
 *
 * Feeds the agent presence (application/agent-presence.ts): after an AI
 * client saves a model, the elements it changed become its canvas SELECTION,
 * so co-editors see the outlines where the agent worked — the equivalent of
 * a human's cursor. Notation-agnostic on purpose: ModelGraph is the analysis
 * seam every extractor answers (bpmn, dmn, the Miragon notations), so the
 * same function covers all of them; the client renders outlines from ids it
 * finds in its own element registry and ignores the rest.
 *
 * Added and changed ids only — a removed element has nothing left to outline.
 * Pure: graphs in, ids out.
 */
import type { ModelGraph } from "@bpmiq/notations/extract";

/** the client renders at most this many outlines per peer (presence-canvas
 *  MAX_OUTLINES) — capping at the source keeps the awareness payload small */
export const MAX_CHANGED_IDS = 50;

/** JSON with sorted keys — element identity is its content, not key order */
function canonical(value: unknown): string {
  return JSON.stringify(value, (_key, v: unknown) =>
    v !== null && typeof v === "object" && !Array.isArray(v)
      ? Object.fromEntries(
          Object.entries(v as Record<string, unknown>).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)),
        )
      : v,
  );
}

function elementsOf(graph: ModelGraph | undefined): Map<string, string> {
  const out = new Map<string, string>();
  if (!graph) return out;
  for (const node of graph.nodes) out.set(node.id, canonical(node));
  for (const edge of graph.edges) out.set(edge.id, canonical(edge));
  return out;
}

/** ids of the elements that are new or different in `next` (in `next` order,
 *  capped at MAX_CHANGED_IDS); [] when nothing graph-visible changed */
export function changedElementIds(previous: ModelGraph | undefined, next: ModelGraph | undefined): string[] {
  const before = elementsOf(previous);
  const changed: string[] = [];
  for (const [id, shape] of elementsOf(next)) {
    if (before.get(id) === shape) continue;
    changed.push(id);
    if (changed.length >= MAX_CHANGED_IDS) break;
  }
  return changed;
}
