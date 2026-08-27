/**
 * bpmn-js wrapper: Modeler (editable) or NavigatedViewer (readonly / the
 * LIVE_MCP_READONLY surface). Dirty tracking rides the command stack; the
 * caller decides what "dirty" means for its save lifecycle.
 */
import Modeler from "bpmn-js/lib/Modeler";
import NavigatedViewer from "bpmn-js/lib/NavigatedViewer";

import { bpmiqModdle, bpmnStickyModule, bpmnStickyViewModule } from "@/notations/bpmn-sticky";

export interface ModelerHandle {
  importXml(xml: string): Promise<void>;
  saveXml(): Promise<string>;
  editable: boolean;
  onDirty(cb: () => void): void;
  /** the single selected element's id (labels resolve to their target), or
   *  undefined — read at click time by the "Open in bpmiq" deep link */
  selectedElementId(): string | undefined;
  destroy(): void;
  /** the underlying bpmn-js instance — bindBpmn (live mode) needs it raw */
  raw: Modeler | NavigatedViewer;
}

export function mountModeler(container: HTMLElement, readonly: boolean): ModelerHandle {
  // stickies (#117): the editable widget gets the FULL module (workshop-
  // gated palette, n-key, persistence — identical to the web editor), the
  // viewer the render-only subset (the full set injects services a viewer
  // does not register and would fail DI on mount)
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
  const dirtyCbs: Array<() => void> = [];
  if (!readonly) {
    // fires on every applied/undone command — exactly the web editor's signal
    (instance as Modeler).on("commandStack.changed", () => {
      for (const cb of dirtyCbs) cb();
    });
  }
  return {
    raw: instance,
    editable: !readonly,
    async importXml(xml: string): Promise<void> {
      await instance.importXML(xml);
      const canvas = instance.get("canvas") as { zoom: (mode: string) => void };
      canvas.zoom("fit-viewport");
    },
    async saveXml(): Promise<string> {
      const { xml } = await (instance as Modeler).saveXML({ format: true });
      if (!xml) throw new Error("empty model");
      return xml;
    },
    onDirty(cb: () => void): void {
      dirtyCbs.push(cb);
    },
    selectedElementId(): string | undefined {
      try {
        const selection = instance.get("selection") as { get(): Array<{ id: string; labelTarget?: { id: string } }> };
        const selected = selection.get();
        if (selected.length !== 1) return undefined;
        return selected[0]?.labelTarget?.id ?? selected[0]?.id;
      } catch {
        return undefined; // a viewer build without the selection service
      }
    },
    destroy(): void {
      instance.destroy();
    },
  };
}
