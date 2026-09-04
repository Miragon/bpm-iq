/**
 * The Team-Topology editor ENGINE — loaded on demand by the manifest
 * (team-topology.tsx). The Miragon team-topologies-modeler (diagram-js)
 * bound to the shared Y.Text via bindTeamTopology; the schema-model codec
 * (lib/tt-codec.ts — shared with the MCP-App widget so both serialize the
 * same bytes) is injected so the live-client adapter never depends on the
 * renderer's packages.
 */
import "@miragon/team-topologies-renderer/assets/team-topologies.css";

import { bindTeamTopology } from "@bpmiq/live-client/tt-sync";
import { Modeler } from "@miragon/team-topologies-renderer";

import { attachPresenceCanvas } from "@/lib/presence-canvas";
import { ttCodec } from "@/lib/tt-codec";

import type { EditorContext, MountedEditor } from "./registry";

export function mountTeamTopologyEditor(container: HTMLElement, ctx: EditorContext): MountedEditor {
  const modeler = new Modeler({ container });
  const unbind = bindTeamTopology(modeler as never, ttCodec, ctx.ytext, ctx.doc, ctx.onSyncError, ctx.onImportFailed);
  const presenceCanvas = ctx.presence ? attachPresenceCanvas(modeler as never, ctx.presence) : undefined;
  return {
    destroy: () => {
      presenceCanvas?.destroy();
      unbind();
      modeler.destroy();
    },
  };
}
