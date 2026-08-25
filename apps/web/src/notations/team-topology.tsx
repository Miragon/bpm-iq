/**
 * The Team-Topology web plugin MANIFEST — light, eager data; the engine
 * (@miragon/team-topologies-renderer + schema-model) loads behind the dynamic
 * import as its own chunk.
 */
import type { WebNotationPlugin } from "./registry";

export const teamTopologyPlugin: WebNotationPlugin = {
  id: "team-topology",
  canvasClassName: "tt-canvas",
  mountEditor: async (container, ctx) => {
    const { mountTeamTopologyEditor } = await import("./team-topology-editor");
    return mountTeamTopologyEditor(container, ctx);
  },
};
