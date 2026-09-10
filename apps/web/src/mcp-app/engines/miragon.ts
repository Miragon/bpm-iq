/**
 * The widget engine of every Miragon renderer — the widget twin of
 * live-client's miragon-sync, parameterised by the SAME text lane (the spec's
 * `load()` hands both the renderer and its lane over):
 *
 *  - "dsl" (wardley OWM, event storming .storm): the text lane IS the DSL
 *    (importDSL/exportDSL round-trip losslessly), and the one trap is shared
 *    with the live binding: importDSL runs commandStack.clear(), which EMITS
 *    'commandStack.changed' (bpmn-js clears silently). Without suppression
 *    the echo would mark the canvas dirty on every load and conflict reload
 *    and autosave the CANONICAL serialization over the hand-authored file —
 *    so onDirty ignores everything raised while importText runs (engine
 *    invariant 1). The read-only mount needs the inert command stack
 *    (diagram-js.ts): the import clears a stack only the Modeler registers.
 *  - "document" (team topology .tt, context map .cm.json): the document is a
 *    typed object, so the text lane goes through the spec's codec — the SAME
 *    codec the SPA's live binding uses, so a widget save and the live export
 *    serialize the same bytes. importDocument replaces every shape but leaves
 *    the command stack UNTOUCHED (an undo would then act on removed objects),
 *    so the EDITABLE mount erases history after each import, silently. The
 *    viewer registers no command stack at all (and the renderer's get()
 *    forwards no strict flag: a lookup would throw), so the clear is gated on
 *    the mount, not on a lookup; importDocument never touches the stack, so
 *    no shim either.
 *
 * Renderer constructors come from the loaded spec (the node --test suite
 * hands in fakes); this module imports neither a renderer nor a stylesheet.
 */
import {
  asDocumentModeler,
  asDslModeler,
  bindMiragon,
  type DocumentModelerLike,
  type DslModelerLike,
  type MiragonLane,
} from "@bpmiq/live-client/miragon-sync";
import type * as Y from "yjs";

import { attachPresenceCanvas } from "../../lib/presence-canvas.ts";
import type { LoadedMiragonRenderer, MiragonRendererLike } from "../../notations/miragon/spec.ts";
import type { LiveBindHooks, WidgetEngine } from "../core/engine.ts";
import { fitViewport, selectedElementOf, viewerCommandStackShim } from "./diagram-js.ts";

export interface MiragonEngine extends WidgetEngine {
  /** the renderer instance — for tests and future extras */
  raw: MiragonRendererLike;
}

export function mountMiragonEngine(
  renderer: LoadedMiragonRenderer,
  container: HTMLElement,
  readonly: boolean,
): MiragonEngine {
  const { lane } = renderer;
  const instance = readonly
    ? new renderer.NavigatedViewer(
        lane.kind === "dsl" ? { container, additionalModules: [viewerCommandStackShim] } : { container },
      )
    : new renderer.Modeler({ container });
  const text =
    lane.kind === "dsl"
      ? dslText(asDslModeler(instance), lane)
      : documentText(asDocumentModeler(instance), lane, readonly);
  let importing = false;
  const dirtyCbs = new Set<() => void>();
  if (!readonly) {
    const changed = (): void => {
      if (importing) return; // the importDSL clear() echo — not a user edit
      for (const cb of dirtyCbs) cb();
    };
    for (const event of text.changeEvents) instance.on(event, changed);
  }
  return {
    raw: instance,
    editable: !readonly,
    async importText(content: string): Promise<void> {
      importing = true;
      try {
        await text.importText(content);
      } finally {
        importing = false;
      }
      fitViewport(instance);
    },
    async exportText(): Promise<string> {
      if (readonly) throw new Error("read-only view");
      return text.exportText();
    },
    onDirty(cb: () => void): () => void {
      dirtyCbs.add(cb);
      return () => dirtyCbs.delete(cb);
    },
    selectedElementId: () => selectedElementOf(instance),
    bindLive(ytext: Y.Text, doc: Y.Doc, hooks: LiveBindHooks): () => void {
      const unbind = bindMiragon(instance, lane, ytext, doc, hooks.onConflict, hooks.onImportError);
      // every Miragon renderer is diagram-js — the SPA's presence controller
      // attaches unchanged (notations/miragon/editor.ts does the same)
      const presence = hooks.presence ? attachPresenceCanvas(instance as never, hooks.presence) : undefined;
      return () => {
        presence?.destroy();
        unbind();
      };
    },
    destroy(): void {
      instance.destroy();
    },
  };
}

/** the lane-specific half of the engine: which events mean "user edit", how
 *  text goes in and comes out */
interface TextLane {
  changeEvents: readonly string[];
  importText(text: string): Promise<void>;
  exportText(): string;
}

function dslText(modeler: DslModelerLike, lane: Extract<MiragonLane, { kind: "dsl" }>): TextLane {
  return {
    changeEvents: lane.changeEvents,
    importText: async (text) => {
      await modeler.importDSL(text);
    },
    exportText: () => modeler.exportDSL(),
  };
}

function documentText(
  modeler: DocumentModelerLike,
  lane: Extract<MiragonLane, { kind: "document" }>,
  readonly: boolean,
): TextLane {
  return {
    // importDocument emits nothing and clear(false) is silent — no echo to suppress
    changeEvents: ["commandStack.changed"],
    importText: async (text) => {
      const parsed = lane.codec.parse(text);
      if (!parsed.ok) throw new Error(`not a ${lane.notation} document: ${String(parsed.error ?? "parse failed")}`);
      modeler.importDocument(parsed.document);
      // the editable mount only — the viewer has no command stack (see header)
      if (!readonly) modeler.get("commandStack").clear(false);
    },
    exportText: () => lane.codec.serialize(modeler.exportDocument()),
  };
}
