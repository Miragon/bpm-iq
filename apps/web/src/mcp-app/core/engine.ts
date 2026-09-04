/**
 * The engine contract the widget core drives — the @miragon/modeler-api
 * profile as bpmiq consumes it (this core is its first consumer): import and
 * export the document TEXT, report user edits, optionally hand the canvas to
 * a Y.Text. Two invariants the lifecycle relies on:
 *
 *  1. importText never fires onDirty. The Miragon DSL renderers run
 *     commandStack.clear() inside importDSL, which EMITS 'commandStack.changed'
 *     (bpmn-js clears silently) — an adapter suppresses that echo exactly like
 *     live-client's dsl-sync does, or every load and every conflict reload
 *     would autosave a canonicalised file over the hand-authored one.
 *  2. bindLive is a CAPABILITY. Absent = the widget stays on CAS autosave —
 *     the DMN widget's deliberate mode, so DMN can ride this core later
 *     without an interface change; any renderer without a live-client
 *     binding mounts the same way.
 *
 * Anything a notation's extras need beyond this (bpmn: the raw bpmn-js
 * instance for todos / t.BPM) rides on the concrete engine type, never here.
 * Pure types: this module is imported by the node --test suites, so it must
 * never pull DOM-bound code.
 */
import type * as Y from "yjs";

/** what a live binding may report back while the Y.Text owns the canvas */
export interface LiveBindHooks {
  /** overlapping concurrent edit — the remote change won (model-sync rule 4) */
  onConflict(message: string): void;
  /** a remote snapshot did not import — reported by the binds that support it
   *  (bindBpmn reports nothing; the core tolerates silence) */
  onImportError(message: string): void;
}

export interface WidgetEngine {
  /** false on the viewer (the LIVE_MCP_READONLY boot flag): no save button,
   *  onDirty never fires, no live upgrade */
  readonly editable: boolean;
  /** parse + render the document text in the notation's own format. Rejects
   *  on an unrenderable document — the caller keeps its previous canvas AND
   *  its previous baseVersion. Must not fire onDirty (invariant 1). */
  importText(text: string): Promise<void>;
  /** the current canvas as the exact text a CAS save sends — the same
   *  serialization the SPA's live binding exports (formatted XML, canonical
   *  DSL, pretty JSON), so the byte lineage stays shared. Rejects on a viewer. */
  exportText(): Promise<string>;
  /** a USER edit changed the document (command stack, config). Never during
   *  importText, never on a viewer. Returns the unsubscribe. */
  onDirty(cb: () => void): () => void;
  /** the single selected element's id (labels resolve to their target), or
   *  undefined — a capability: today only the bpmn deep link reads it */
  selectedElementId?(): string | undefined;
  /** hand the canvas to the SPA's Y.Text binding; returns the unbind. Called
   *  at most once per live session, on an editable engine, AFTER the core
   *  flushed unsaved state. Absent = no live binding for this notation. */
  bindLive?(ytext: Y.Text, doc: Y.Doc, hooks: LiveBindHooks): () => void;
  destroy(): void;
}

/** an engine the core may upgrade to live — bindLive present */
export type LiveEngine = WidgetEngine & Required<Pick<WidgetEngine, "bindLive">>;

/** mounts the engine into the widget's #canvas — editor or viewer */
export type EngineFactory<E extends WidgetEngine = WidgetEngine> = (container: HTMLElement, readonly: boolean) => E;
