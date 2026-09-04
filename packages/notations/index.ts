/**
 * @bpmiq/notations — the ONE place that knows what a modeling notation is.
 *
 * The descriptor here is pure DATA (extensions, media kind, noun, doc shape,
 * graph hints) — this module is imported EAGERLY by the web SPA and must stay
 * zero-dep and browser-safe (CI: notations-index-and-derive-stay-browser-safe).
 * BEHAVIOR attaches per capability in sibling modules keyed by descriptor id,
 * statically composed:
 *   - ./extract    raw file text → generic ModelGraph (extractModelGraph)
 *   - ./derive     ModelGraph → derived views (deriveView + the rich per-
 *                  notation views deriveProcess/deriveDecision)
 *   - ./templates  blank-model file content (templateFor)
 *   - ./content    content-repo discovery over any checkout (Node-only)
 *   - @bpmiq/validator  checkModel — the platform check per notation (the
 *                  checkers stay OUT of this package: the published
 *                  bpmiq-validate binary owns them)
 *
 * Adding a notation = one descriptor here + one entry per capability it
 * offers. A descriptor with no capabilities still gets everything generic:
 * live room, Monaco editing, discovery, listing, release, history.
 */

export type MediaKind = "xml" | "json" | "dsl" | "markdown";

/** the CRDT strategy of a notation's live document — "text" is one shared
 *  Y.Text (today's contract); "structured" (element-wise Y.Map, epic #118
 *  step 8) is reserved for canvas notations */
export type DocShape = "text" | "structured";

export interface NotationDescriptor {
  /** stable id, used as key in tooling and per-capability registries */
  id: string;
  label: string;
  /** how listings/tools name ONE artifact of this notation — drives tool COPY
   *  (error messages, capability listings). Deliberately NOT tool names: the
   *  existing *_process/*_decision names are wire-pinned and the noun scheme
   *  would mint new parallel names (#123, recorded on the ticket). */
  noun: { singular: string; plural: string };
  /** file suffixes, compound suffixes allowed (".vc.json") — longest wins */
  extensions: string[];
  mediaKind: MediaKind;
  docShape: DocShape;
  /** Monaco language id for the text view of this notation */
  monacoLanguage: string;
  /** what "flow" means in this notation's ModelGraph — lets generic graph
   *  analyses (path enumeration, cycles) work per notation instead of
   *  hard-coding BPMN vocabulary (consumed in epic #118 step 5) */
  graphHints?: { flowEdgeKinds: string[]; entryNodeTypes: string[] };
}

export const NOTATIONS: readonly NotationDescriptor[] = [
  {
    id: "bpmn",
    label: "BPMN 2.0",
    noun: { singular: "process", plural: "processes" },
    extensions: [".bpmn"],
    mediaKind: "xml",
    docShape: "text",
    monacoLanguage: "xml",
    graphHints: { flowEdgeKinds: ["sequenceFlow"], entryNodeTypes: ["startEvent"] },
  },
  {
    id: "dmn",
    label: "DMN",
    noun: { singular: "decision", plural: "decisions" },
    extensions: [".dmn"],
    mediaKind: "xml",
    docShape: "text",
    monacoLanguage: "xml",
    graphHints: { flowEdgeKinds: ["informationRequirement"], entryNodeTypes: [] },
  },
  {
    id: "wardley",
    label: "Wardley Map",
    noun: { singular: "wardley map", plural: "wardley maps" },
    extensions: [".owm", ".wmap"],
    mediaKind: "dsl",
    docShape: "text",
    monacoLanguage: "plaintext",
    graphHints: { flowEdgeKinds: ["dependency"], entryNodeTypes: [] },
  },
  {
    id: "team-topology",
    label: "Team Topology",
    noun: { singular: "team topology", plural: "team topologies" },
    extensions: [".tt", ".ttm.json"],
    mediaKind: "json",
    docShape: "text",
    monacoLanguage: "json",
  },
  {
    id: "event-storming",
    label: "Event Storming",
    noun: { singular: "event storming board", plural: "event storming boards" },
    extensions: [".storm"],
    mediaKind: "dsl",
    docShape: "text",
    monacoLanguage: "plaintext",
    graphHints: { flowEdgeKinds: ["arrow"], entryNodeTypes: [] },
  },
  {
    id: "value-chain",
    label: "Value Chain",
    noun: { singular: "value chain", plural: "value chains" },
    extensions: [".vc.json"],
    mediaKind: "json",
    docShape: "text",
    monacoLanguage: "json",
  },
  {
    id: "markdown",
    label: "Markdown",
    noun: { singular: "document", plural: "documents" },
    extensions: [".md"],
    mediaKind: "markdown",
    docShape: "text",
    monacoLanguage: "markdown",
  },
];

export function byId(id: string): NotationDescriptor | undefined {
  return NOTATIONS.find((n) => n.id === id);
}

/** longest-suffix winner across every registered extension, so ".vc.json"
 *  beats a hypothetical ".json" — shared by byExtension and modelStem */
function longestMatch(path: string): { notation: NotationDescriptor; ext: string } | undefined {
  let best: { notation: NotationDescriptor; ext: string } | undefined;
  for (const n of NOTATIONS) {
    for (const ext of n.extensions) {
      if (path.endsWith(ext) && ext.length > (best?.ext.length ?? 0)) {
        best = { notation: n, ext };
      }
    }
  }
  return best;
}

export function byExtension(path: string): NotationDescriptor | undefined {
  return longestMatch(path)?.notation;
}

/**
 * The file stem that IS a model's id (the content contract: a process is its
 * .bpmn file, a decision its .dmn file). Strips the FULL registered extension,
 * so compound suffixes resolve correctly ("a.vc.json" → "a", never "a.vc");
 * unknown extensions fall back to stripping the final dot-suffix.
 */
export function modelStem(path: string): string {
  const base = path.split("/").pop() ?? path;
  const ext = longestMatch(base)?.ext;
  return ext ? base.slice(0, -ext.length) : base.replace(/\.[^.]+$/, "");
}

/**
 * Derive a process id (= file stem, kebab-case) from a human title — the ONE
 * slug rule the create-process backend and the web client's live preview
 * share. "" means the title contains nothing usable (caller rejects).
 */
export function processIdFromName(name: string): string {
  return name
    .normalize("NFKD") // decompose accents (\u00e4 -> a + combining mark), stripped next
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/\u00df/g, "ss")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

const NOTATION_EXTENSIONS: readonly string[] = NOTATIONS.flatMap((n) => n.extensions);

/**
 * Everything the Live Host serves as a collaborative document: all notation
 * files plus the text artifacts that live next to them.
 */
export const EDITABLE_EXTENSIONS: readonly string[] = [...NOTATION_EXTENSIONS, ".yaml", ".yml"];
