/**
 * The Event Storming web plugin MANIFEST — light, eager data; the engine
 * (@miragon/event-storming-renderer) loads behind the dynamic import as its
 * own chunk.
 */
import type { WebNotationPlugin } from "./registry";

export const eventStormingPlugin: WebNotationPlugin = {
  id: "event-storming",
  canvasClassName: "es-canvas",
  mountEditor: async (container, ctx) => {
    const { mountEventStormingEditor } = await import("./event-storming-editor");
    return mountEventStormingEditor(container, ctx);
  },
};
