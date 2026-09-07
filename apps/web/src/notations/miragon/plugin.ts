/**
 * The web plugin MANIFEST of a Miragon renderer — light, eager data derived
 * from its spec; the engine (renderer + stylesheet + the live binding) loads
 * behind the dynamic imports on mount, as its own chunk.
 */
import type { WebNotationPlugin } from "../registry";
import type { MiragonRendererSpec } from "./spec";

export function miragonPlugin(spec: MiragonRendererSpec): WebNotationPlugin {
  return {
    id: spec.id,
    canvasClassName: spec.canvasClassName,
    mountEditor: async (container, ctx) => {
      const [{ mountMiragonEditor }, renderer] = await Promise.all([import("./editor"), spec.load()]);
      return mountMiragonEditor(renderer, container, ctx);
    },
  };
}
