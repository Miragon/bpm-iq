/**
 * Y.Text ↔ Miragon-modeler binding — the ONE adapter for every diagram-js
 * modeler built from the Miragon modeler template (wardley maps, event
 * storming, team topologies, context maps) on the shared sync engine
 * (model-sync.ts; the four rules live there). What differs between those
 * renderers is not the notation but the TEXT LANE their API exposes — the
 * `MiragonLane` discriminator, chosen per notation by the web client's
 * renderer spec (apps/web/src/notations/miragon/<notation>.ts):
 *
 *  - "dsl": the file format is a lossless line-DSL round-trip
 *    (importDSL/exportDSL — wardley OWM, event storming .storm); the text
 *    lane carries the DSL directly. Two traits from the renderers' own
 *    VS-Code-webview recipes: importDSL runs commandStack.clear(), which
 *    EMITS 'changed' (unlike bpmn-js, which clears silently) — without
 *    suppression that echo would re-export the canvas's CANONICAL
 *    serialization after every import, reordering a hand-authored file on
 *    open and replacing half-typed Monaco text after every debounce (the
 *    reference webviews drop the echo the same way: `if (importing) return`
 *    in their pushEdit). And the DSLs are lenient by design (unknown lines
 *    are preserved), so the rule-4 pre-gate is "any non-empty text" — the
 *    parser stays the judge. Per notation only the CHANGE EVENTS differ:
 *    wardley's axis-label edits fire 'wardley.config.changed', not the
 *    command stack; an event storming board's view options are a display
 *    preference, never content.
 *  - "document": the file format is ONE JSON document with a schema-model
 *    codec (importDocument/exportDocument — team topology .tt, context map
 *    .cm.json). The codec — Zod-validated, non-throwing parse on the way in,
 *    deterministic serialize on the way out — is INJECTED, so this package
 *    never depends on a renderer's schema package. importDocument replaces
 *    every shape but leaves the command stack UNTOUCHED (an undo would then
 *    operate on stale, removed objects: silent no-ops, id-coincidence
 *    deletions) — history is erased like bpmn-js does on import, silently
 *    (clear(false): no 'changed' echo). The codec's parse IS the rule-4
 *    pre-gate: half-typed JSON keeps the last good canvas without an import
 *    round-trip. Every canvas edit runs through the command stack, and the
 *    document meta (title) has no editing surface on the canvas —
 *    commandStack.changed is the ONE change event.
 *
 * Both lanes share the diagram-js canvas whose viewbox survives a re-import.
 * Issue #136 (@miragon/modeler-api) retires the lane split upstream: once the
 * renderers implement importText/exportText with a silent import, this
 * module shrinks to one lane and the specs to `{ id, load }`.
 */
import type * as Y from "yjs";

import { bindModelSync, keepDiagramViewbox, type SyncAdapter } from "./model-sync.ts";

/** the diagram-js surface every Miragon renderer shares — STRUCTURALLY: each
 *  renderer pins its own diagram-js copy, so nothing here may instanceof */
export interface MiragonModelerLike {
  get(service: string): any;
  on(event: string, cb: () => void): void;
  off(event: string, cb: () => void): void;
}

/** a renderer whose text lane is a lossless line DSL (wardley, event storming) */
export interface DslModelerLike extends MiragonModelerLike {
  importDSL(text: string): Promise<unknown>;
  exportDSL(): string;
}

/** a renderer whose text lane is one JSON document behind a schema-model
 *  codec (team topologies, context maps) */
export interface DocumentModelerLike extends MiragonModelerLike {
  get(service: "commandStack"): { clear(emitChanged?: boolean): void };
  get(service: string): any;
  importDocument(document: unknown): unknown;
  exportDocument(): unknown;
}

export type MiragonModeler = DslModelerLike | DocumentModelerLike;

export interface DocumentCodec {
  /** non-throwing parse — `ok: false` keeps the last good canvas (rule 4) */
  parse(text: string): { ok: true; document: unknown } | { ok: false; error?: unknown };
  /** deterministic serialization (diff-friendly, the modeler's house rule) */
  serialize(document: unknown): string;
}

/** HOW a Miragon renderer exposes its text lane — the one thing that differs
 *  between the renderers (see the module header) */
export type MiragonLane =
  | {
      kind: "dsl";
      /** the events after which the canvas is re-exported into the text lane */
      changeEvents: readonly string[];
    }
  | {
      kind: "document";
      /** the notation's name in the rejection message ("not a team-topology document") */
      notation: string;
      codec: DocumentCodec;
    };

/** a spec/renderer mismatch must fail at bind time with a readable message,
 *  not as "importDSL is not a function" inside a debounced import */
export function asDslModeler(modeler: MiragonModeler): DslModelerLike {
  if (typeof (modeler as Partial<DslModelerLike>).importDSL !== "function") {
    throw new Error("lane 'dsl' needs a renderer with importDSL/exportDSL");
  }
  return modeler as DslModelerLike;
}

export function asDocumentModeler(modeler: MiragonModeler): DocumentModelerLike {
  if (typeof (modeler as Partial<DocumentModelerLike>).importDocument !== "function") {
    throw new Error("lane 'document' needs a renderer with importDocument/exportDocument");
  }
  return modeler as DocumentModelerLike;
}

export function bindMiragon(
  modeler: MiragonModeler,
  lane: MiragonLane,
  ytext: Y.Text,
  doc: Y.Doc,
  onConflict?: (message: string) => void,
  onImportError?: (message: string) => void,
): () => void {
  const adapter =
    lane.kind === "dsl"
      ? dslLane(asDslModeler(modeler), lane.changeEvents)
      : documentLane(asDocumentModeler(modeler), lane);
  return bindModelSync(
    { ...adapter, beforeImport: keepDiagramViewbox(modeler) },
    ytext,
    doc,
    onConflict,
    onImportError,
  );
}

type LaneAdapter = Omit<SyncAdapter, "beforeImport">;

function dslLane(modeler: DslModelerLike, changeEvents: readonly string[]): LaneAdapter {
  let importing = false;
  return {
    importText: async (text) => {
      importing = true;
      try {
        await modeler.importDSL(text);
      } finally {
        importing = false;
      }
    },
    exportText: async () => modeler.exportDSL(),
    // lenient DSL: the parser is the judge — only emptiness is gated here
    looksRenderable: (text) => text.trim().length > 0,
    observeModel(onChanged) {
      const handler = (): void => {
        if (!importing) onChanged(); // the importDSL clear() echo — not a user edit
      };
      for (const event of changeEvents) modeler.on(event, handler);
      return () => {
        for (const event of changeEvents) modeler.off(event, handler);
      };
    },
  };
}

function documentLane(modeler: DocumentModelerLike, lane: { notation: string; codec: DocumentCodec }): LaneAdapter {
  return {
    importText: async (text) => {
      const parsed = lane.codec.parse(text);
      if (!parsed.ok) throw new Error(`not a ${lane.notation} document: ${String(parsed.error ?? "parse failed")}`);
      modeler.importDocument(parsed.document);
      // the renderer's importDocument replaces every shape but leaves the
      // command stack UNTOUCHED — erase history like bpmn-js does on import,
      // silently (no 'changed' echo)
      modeler.get("commandStack").clear(false);
    },
    exportText: async () => lane.codec.serialize(modeler.exportDocument()),
    // rule-4 pre-gate: the codec's parse IS the gate — run it cheaply here so a
    // half-typed JSON keeps the last good canvas without an import round-trip
    looksRenderable: (text) => lane.codec.parse(text).ok,
    observeModel(onChanged) {
      modeler.on("commandStack.changed", onChanged);
      return () => modeler.off("commandStack.changed", onChanged);
    },
  };
}
