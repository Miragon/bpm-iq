/**
 * The Context Map web plugin MANIFEST — light, eager data; the engine
 * (@miragon/context-maps-renderer + schema-model) loads behind the dynamic
 * import as its own chunk.
 */
import type { WebNotationPlugin } from "./registry";

export const contextMapPlugin: WebNotationPlugin = {
  id: "context-map",
  canvasClassName: "cm-canvas",
  mountEditor: async (container, ctx) => {
    const { mountContextMapEditor } = await import("./context-map-editor");
    return mountContextMapEditor(container, ctx);
  },
};
