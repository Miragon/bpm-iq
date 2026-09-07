/** @miragon/wardley-renderer — the OWM DSL round-trips losslessly
 *  (importDSL/exportDSL), so the text tab and the canvas edit one document */
import type { LoadedMiragonRenderer, MiragonRendererCtor, MiragonRendererSpec } from "./spec.ts";

export const spec: MiragonRendererSpec = {
  id: "wardley",
  pkg: "@miragon/wardley-renderer",
  canvasClassName: "wardley-canvas",
  vendorRoot: "wardley-container",
  async load(): Promise<LoadedMiragonRenderer> {
    const [{ Modeler, NavigatedViewer }] = await Promise.all([
      import("@miragon/wardley-renderer"),
      import("@miragon/wardley-renderer/assets/wardley.css"),
    ]);
    return {
      Modeler: Modeler as unknown as MiragonRendererCtor,
      NavigatedViewer: NavigatedViewer as unknown as MiragonRendererCtor,
      // the one wardley specific, from the modeler's own VS-Code-webview
      // recipe: config edits (axis labels via setEvolutionLabels) fire
      // `wardley.config.changed`, NOT `commandStack.changed` — observe both
      lane: { kind: "dsl", changeEvents: ["commandStack.changed", "wardley.config.changed"] },
    };
  },
};
