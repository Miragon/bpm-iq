/**
 * The Team-Topology editor ENGINE — loaded on demand by the manifest
 * (team-topology.tsx). The Miragon team-topologies-modeler (diagram-js)
 * bound to the shared Y.Text via bindTeamTopology; the schema-model codec
 * (Zod-validated parse, deterministic serialize) is injected so the shared
 * live-client adapter never depends on the renderer's packages.
 */
import "@miragon/team-topologies-renderer/assets/team-topologies.css";

import { bindTeamTopology } from "@bpmiq/live-client/tt-sync";
import { Modeler } from "@miragon/team-topologies-renderer";
import { parseDocument, serializeDocument, type TtDocument } from "@miragon/team-topologies-schema-model";

import { attachPresenceCanvas } from "@/lib/presence-canvas";

import type { EditorContext, MountedEditor } from "./registry";

export function mountTeamTopologyEditor(container: HTMLElement, ctx: EditorContext): MountedEditor {
  const modeler = new Modeler({ container });
  const unbind = bindTeamTopology(
    modeler as never,
    {
      // parseDocument is deliberately LENIENT (the modeler's own semantics):
      // any object migrates to a valid document with defaults — typing "{}"
      // in the text tab is a legal empty board, not a rejected edit
      parse: (text) => {
        try {
          const parsed = parseDocument(JSON.parse(text));
          return parsed.ok ? { ok: true, document: parsed.document } : { ok: false, error: parsed.error };
        } catch (e) {
          return { ok: false, error: e };
        }
      },
      serialize: (document) => serializeDocument(document as TtDocument, true),
    },
    ctx.ytext,
    ctx.doc,
    ctx.onSyncError,
    ctx.onImportFailed,
  );
  const presenceCanvas = ctx.presence ? attachPresenceCanvas(modeler as never, ctx.presence) : undefined;
  return {
    destroy: () => {
      presenceCanvas?.destroy();
      unbind();
      modeler.destroy();
    },
  };
}
