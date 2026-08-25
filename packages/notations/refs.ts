/**
 * The refs capability: typed cross-model references, keyed by descriptor id —
 * the substrate that turns separate models into ONE architecture (epic #118
 * step 4). refsOf(graph) is the generic dispatch; per-notation emitters turn
 * a ModelGraph into the outgoing references its notation defines. Consumers:
 * the validator's generic dangling-ref rule, the repo index (./content
 * buildRepoIndex), which_models_use, and the release PR's reference section.
 *
 * Pure + browser-safe: operates on the already-parsed ModelGraph, no fs, no
 * XML — same discipline as ./derive.
 */
import type { ModelGraph } from "./extract.ts";

/**
 * One outgoing cross-model reference, as emitted from a single model's graph.
 * The source PATH is attached by the indexer (the graph does not know it).
 */
export interface ModelRef {
  /** element id in the source model the reference hangs on */
  fromElement?: string;
  /** the relation: "calls" (callActivity), "decides" (businessRuleTask), and
   *  notation-defined kinds to come ("realized-by", "owned-by", "mentions", …) */
  rel: string;
  to: {
    /** target model id (= file stem) */
    id: string;
    /** target notation — absent means "any notation with that stem" */
    notation?: string;
    /** optional element inside the target (reserved; not resolved yet) */
    element?: string;
  };
  /** "required" refs WARN when unresolved (the callActivity behavior);
   *  "informative" refs never fail validation (e.g. markdown mentions) */
  strength: "required" | "informative";
}

const REF_EMITTERS: Record<string, (graph: ModelGraph) => ModelRef[]> = {
  bpmn: (graph) => {
    // two passes — all calls, then all decides — preserving the historical
    // grouping of the validator's link warnings (wire-visible order)
    const refs: ModelRef[] = [];
    for (const n of graph.nodes) {
      const calls = n.extra?.calledElement;
      if (n.type === "callActivity" && typeof calls === "string" && calls) {
        refs.push({ fromElement: n.id, rel: "calls", to: { id: calls, notation: "bpmn" }, strength: "required" });
      }
    }
    for (const n of graph.nodes) {
      const decides = n.extra?.decisionRef;
      if (n.type === "businessRuleTask" && typeof decides === "string" && decides) {
        refs.push({ fromElement: n.id, rel: "decides", to: { id: decides, notation: "dmn" }, strength: "required" });
      }
    }
    return refs;
  },
};

/**
 * THE generic refs dispatch: every outgoing cross-model reference of the
 * graph; [] when the notation emits none. Registering a notation's emitter
 * here is the whole integration — resolver, index, validation and the
 * release PR section pick it up with zero consumer changes.
 */
export function refsOf(graph: ModelGraph): ModelRef[] {
  return REF_EMITTERS[graph.notation]?.(graph) ?? [];
}

/** whether a notation emits refs at all — lets save paths skip the repo-wide
 *  id scan for notations whose checkRefs would be a no-op anyway */
export function hasRefs(notation: string): boolean {
  return notation in REF_EMITTERS;
}
