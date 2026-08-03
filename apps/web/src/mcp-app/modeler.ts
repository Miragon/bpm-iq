/**
 * bpmn-js wrapper: Modeler (editable) or NavigatedViewer (readonly / the
 * LIVE_MCP_READONLY surface). Dirty tracking rides the command stack; the
 * caller decides what "dirty" means for its save lifecycle.
 */
import Modeler from "bpmn-js/lib/Modeler";
import NavigatedViewer from "bpmn-js/lib/NavigatedViewer";

export interface ModelerHandle {
  importXml(xml: string): Promise<void>;
  saveXml(): Promise<string>;
  editable: boolean;
  onDirty(cb: () => void): void;
  destroy(): void;
}

export function mountModeler(container: HTMLElement, readonly: boolean): ModelerHandle {
  const instance = readonly ? new NavigatedViewer({ container }) : new Modeler({ container });
  const dirtyCbs: Array<() => void> = [];
  if (!readonly) {
    // fires on every applied/undone command — exactly the web editor's signal
    (instance as Modeler).on("commandStack.changed", () => {
      for (const cb of dirtyCbs) cb();
    });
  }
  return {
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
    destroy(): void {
      instance.destroy();
    },
  };
}
