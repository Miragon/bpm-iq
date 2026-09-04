/**
 * The BPMN widget engine: bpmn-js Modeler (editable) or NavigatedViewer
 * (readonly / the LIVE_MCP_READONLY surface) behind the widget-core engine
 * contract, plus what the BPMN extras need beyond it — the raw bpmn-js
 * instance for todos (todo-canvas), the t.BPM switch and the live binding.
 *
 * Stickies (#117): the editable widget gets the FULL module (workshop-gated
 * palette, n-key, persistence — identical to the web editor), the viewer the
 * render-only subset (the full set injects services a viewer does not
 * register and would fail DI on mount). bpmn-js clears its command stack
 * SILENTLY on import, so no dirty suppression is needed here (contrast the
 * DSL engines).
 */
import { bindBpmn } from "@bpmiq/live-client/bpmn-sync";
import Modeler from "bpmn-js/lib/Modeler";
import NavigatedViewer from "bpmn-js/lib/NavigatedViewer";
import type * as Y from "yjs";

import { bpmiqModdle, bpmnStickyModule, bpmnStickyViewModule } from "../../notations/bpmn-sticky/index.ts";
import type { EngineFactory, LiveBindHooks, WidgetEngine } from "../core/engine.ts";
import { fitViewport, selectedElementOf } from "./diagram-js.ts";

export interface BpmnEngine extends WidgetEngine {
  /** the underlying bpmn-js instance — todos, the t.BPM switch and the live
   *  binding need it raw */
  raw: Modeler | NavigatedViewer;
}

export const mountBpmnEngine: EngineFactory<BpmnEngine> = (container, readonly) => {
  const instance = readonly
    ? new NavigatedViewer({
        container,
        additionalModules: [bpmnStickyViewModule],
        moddleExtensions: { bpmiq: bpmiqModdle },
      })
    : new Modeler({
        container,
        additionalModules: [bpmnStickyModule],
        moddleExtensions: { bpmiq: bpmiqModdle },
      });
  const dirtyCbs = new Set<() => void>();
  if (!readonly) {
    // fires on every applied/undone command — exactly the web editor's signal
    (instance as Modeler).on("commandStack.changed", () => {
      for (const cb of dirtyCbs) cb();
    });
  }
  return {
    raw: instance,
    editable: !readonly,
    async importText(xml: string): Promise<void> {
      await instance.importXML(xml);
      fitViewport(instance as never);
    },
    async exportText(): Promise<string> {
      if (readonly) throw new Error("read-only view");
      const { xml } = await (instance as Modeler).saveXML({ format: true });
      if (!xml) throw new Error("empty model");
      return xml;
    },
    onDirty(cb: () => void): () => void {
      dirtyCbs.add(cb);
      return () => dirtyCbs.delete(cb);
    },
    selectedElementId: () => selectedElementOf(instance as never),
    // bindBpmn reports no import errors (bpmn-js keeps its old canvas on a
    // failed re-import) — the hook stays unused here by design
    bindLive(ytext: Y.Text, doc: Y.Doc, hooks: LiveBindHooks): () => void {
      return bindBpmn(instance as never, ytext, doc, hooks.onConflict);
    },
    destroy(): void {
      instance.destroy();
    },
  };
};
