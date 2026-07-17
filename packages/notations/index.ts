/**
 * @bpmiq/notations — the ONE place that knows what a modeling notation is.
 *
 * Adding a notation to the platform = adding one descriptor here. Consumers
 * derive their behavior from the registry instead of hard-coding extensions:
 *   - live-host: which files are shareable/editable rooms (EDITABLE_EXTENSIONS)
 *   - validator: which model files process.yaml may declare (schema generation)
 *   - web:       which editor/Monaco language to mount for a file
 *   - mcp:       how to parse a model file for analyses (extract hooks, P5)
 *
 * This package is Node-safe by design: NO browser/editor libraries here.
 * Browser-side factories (bpmn-js, dmn-js, Miragon renderers) belong in a
 * sibling browser package so the server never pulls in DOM dependencies.
 */

export type MediaKind = "xml" | "json" | "dsl";

export interface NotationDescriptor {
  /** stable id, used as key in process.yaml models and in tooling */
  id: string;
  label: string;
  /** file suffixes, compound suffixes allowed (".vc.json") — longest wins */
  extensions: string[];
  mediaKind: MediaKind;
  /** Monaco language id for the text view of this notation */
  monacoLanguage: string;
  /** may files of this notation be declared under process.yaml `models`? */
  processModel: boolean;
}

export const NOTATIONS: readonly NotationDescriptor[] = [
  { id: "bpmn", label: "BPMN 2.0", extensions: [".bpmn"], mediaKind: "xml", monacoLanguage: "xml", processModel: true },
  { id: "dmn", label: "DMN", extensions: [".dmn"], mediaKind: "xml", monacoLanguage: "xml", processModel: true },
  {
    id: "wardley",
    label: "Wardley Map",
    extensions: [".owm", ".wmap"],
    mediaKind: "dsl",
    monacoLanguage: "plaintext",
    processModel: true,
  },
  {
    id: "team-topology",
    label: "Team Topology",
    extensions: [".tt", ".ttm.json"],
    mediaKind: "json",
    monacoLanguage: "json",
    processModel: true,
  },
  {
    id: "value-chain",
    label: "Value Chain",
    extensions: [".vc.json"],
    mediaKind: "json",
    monacoLanguage: "json",
    processModel: true,
  },
];

export function byId(id: string): NotationDescriptor | undefined {
  return NOTATIONS.find((n) => n.id === id);
}

/** longest-suffix match, so ".vc.json" wins over a hypothetical ".json" */
export function byExtension(path: string): NotationDescriptor | undefined {
  let best: NotationDescriptor | undefined;
  let bestLen = 0;
  for (const n of NOTATIONS) {
    for (const ext of n.extensions) {
      if (path.endsWith(ext) && ext.length > bestLen) {
        best = n;
        bestLen = ext.length;
      }
    }
  }
  return best;
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
export const EDITABLE_EXTENSIONS: readonly string[] = [...NOTATION_EXTENSIONS, ".yaml", ".yml", ".md"];
