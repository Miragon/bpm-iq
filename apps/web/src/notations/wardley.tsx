/**
 * The Wardley web plugin MANIFEST — light, eager data; the engine
 * (@miragon/wardley-renderer) loads behind the dynamic import as its own chunk.
 */
import type { WebNotationPlugin } from "./registry";

export const wardleyPlugin: WebNotationPlugin = {
  id: "wardley",
  canvasClassName: "wardley-canvas",
  mountEditor: async (container, ctx) => {
    const { mountWardleyEditor } = await import("./wardley-editor");
    return mountWardleyEditor(container, ctx);
  },
};
