/** @miragon/event-storming-renderer — the .storm DSL round-trips losslessly
 *  (importDSL/exportDSL), so the text tab and the board edit one document */
import type { LoadedMiragonRenderer, MiragonRendererCtor, MiragonRendererSpec } from "./spec.ts";

export const spec: MiragonRendererSpec = {
  id: "event-storming",
  pkg: "@miragon/event-storming-renderer",
  canvasClassName: "es-canvas",
  vendorRoot: "event-storming-container",
  async load(): Promise<LoadedMiragonRenderer> {
    const [{ Modeler, NavigatedViewer }] = await Promise.all([
      import("@miragon/event-storming-renderer"),
      import("@miragon/event-storming-renderer/assets/event-storming.css"),
    ]);
    return {
      Modeler: Modeler as unknown as MiragonRendererCtor,
      NavigatedViewer: NavigatedViewer as unknown as MiragonRendererCtor,
      // every board edit (stickies, arrows, drawings, pinning, colors) runs
      // through the command stack; the board config (title, level, style) has
      // no editing surface on the canvas, and the view-options event is a
      // display preference, never content — one change event
      lane: { kind: "dsl", changeEvents: ["commandStack.changed"] },
    };
  },
};
