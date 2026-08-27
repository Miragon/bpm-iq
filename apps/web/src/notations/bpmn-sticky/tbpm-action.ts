/**
 * The t.BPM header toggle (#117/#54): flips bpmiq:mode on bpmn:Definitions —
 * a DOCUMENT property, so every participant's tooling switches together
 * (palette gating + creation rules key on it). Lives in the shell header via
 * the MountedEditor.actions surface, not in the diagram palette.
 */
import type { EditorToolbarAction } from "../registry";
import { isWorkshopMode, type ModdleLike } from "./sticky-model";

interface ModelerLike {
  get(service: "eventBus"): {
    on(event: string, cb: () => void): void;
    off(event: string, cb: () => void): void;
  };
  get(service: "modeling"): {
    updateModdleProperties(element: unknown, moddleElement: unknown, properties: Record<string, unknown>): void;
  };
  get(service: "canvas"): { getRootElement(): unknown };
  getDefinitions(): ModdleLike | undefined;
}

export function tbpmToggleAction(modeler: ModelerLike): EditorToolbarAction {
  const eventBus = modeler.get("eventBus");
  const modeling = modeler.get("modeling");
  const canvas = modeler.get("canvas");
  return {
    id: "tbpm",
    label: "t.BPM",
    buttonTitle:
      "t.BPM workshop mode: sticky-note discussion tooling — a document setting, every participant switches together",
    isActive: () => isWorkshopMode(modeler.getDefinitions()),
    onChanged: (cb) => {
      // local flips + their undo/redo AND remote flips (arrive via re-import)
      eventBus.on("commandStack.changed", cb);
      eventBus.on("import.done", cb);
      return () => {
        eventBus.off("commandStack.changed", cb);
        eventBus.off("import.done", cb);
      };
    },
    run: () => {
      const definitions = modeler.getDefinitions();
      if (!definitions) return;
      modeling.updateModdleProperties(canvas.getRootElement(), definitions, {
        mode: isWorkshopMode(definitions) ? undefined : "workshop",
      });
    },
  };
}
