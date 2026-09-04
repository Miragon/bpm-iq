/**
 * The widget engine of the Miragon DSL renderers (wardley OWM, event
 * storming .storm) — the widget twin of live-client's dsl-sync: the text lane
 * IS the DSL (importDSL/exportDSL round-trip losslessly), and the one trap is
 * shared: importDSL runs commandStack.clear(), which EMITS
 * 'commandStack.changed' (bpmn-js clears silently). Without suppression the
 * echo would mark the canvas dirty on every load and conflict reload and
 * autosave the CANONICAL serialization over the hand-authored file — so
 * onDirty ignores everything raised while importText runs (engine invariant 1).
 *
 * Renderer constructors are injected as factories (the node --test suite
 * mounts fakes) and the live binding is the notation's live-client adapter,
 * so this module imports neither a renderer nor a stylesheet.
 */
import type * as Y from "yjs";

import type { LiveBindHooks, WidgetEngine } from "../core/engine.ts";
import {
  type DiagramLike,
  fitViewport,
  selectedElementOf,
  viewerCommandStackShim,
  type ViewerModule,
} from "./diagram-js.ts";

export interface DslRendererLike extends DiagramLike {
  importDSL(text: string): Promise<unknown>;
  exportDSL(): string;
}

/** the live-client bind of this notation (bindWardley / bindEventStorming) */
export type DslLiveBind = (
  modeler: DslRendererLike,
  ytext: Y.Text,
  doc: Y.Doc,
  onConflict?: (message: string) => void,
  onImportError?: (message: string) => void,
) => () => void;

export interface DslEngineOptions {
  readonly: boolean;
  /** the vendor Modeler on the container */
  editor: () => DslRendererLike;
  /** the vendor NavigatedViewer on the container WITH the given extra modules
   *  (the inert command stack — see diagram-js.ts) */
  viewer: (additionalModules: ViewerModule[]) => DslRendererLike;
  /** the events after which the document counts as user-edited — the same
   *  set the notation's live-client adapter re-exports on */
  changeEvents: readonly string[];
  bind: DslLiveBind;
}

export interface DslEngine extends WidgetEngine {
  /** the renderer instance — for tests and future extras */
  raw: DslRendererLike;
}

export function mountDslEngine(o: DslEngineOptions): DslEngine {
  const instance = o.readonly ? o.viewer([viewerCommandStackShim]) : o.editor();
  let importing = false;
  const dirtyCbs = new Set<() => void>();
  if (!o.readonly) {
    const changed = (): void => {
      if (importing) return; // the importDSL clear() echo — not a user edit
      for (const cb of dirtyCbs) cb();
    };
    for (const event of o.changeEvents) instance.on(event, changed);
  }
  return {
    raw: instance,
    editable: !o.readonly,
    async importText(text: string): Promise<void> {
      importing = true;
      try {
        await instance.importDSL(text);
      } finally {
        importing = false;
      }
      fitViewport(instance);
    },
    async exportText(): Promise<string> {
      if (o.readonly) throw new Error("read-only view");
      return instance.exportDSL();
    },
    onDirty(cb: () => void): () => void {
      dirtyCbs.add(cb);
      return () => dirtyCbs.delete(cb);
    },
    selectedElementId: () => selectedElementOf(instance),
    bindLive(ytext: Y.Text, doc: Y.Doc, hooks: LiveBindHooks): () => void {
      return o.bind(instance, ytext, doc, hooks.onConflict, hooks.onImportError);
    },
    destroy(): void {
      instance.destroy();
    },
  };
}
