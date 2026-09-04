/** the Team Topology widget engine — @miragon/team-topologies-renderer over
 *  the shared JSON engine, with the ONE codec the SPA editor uses too
 *  (lib/tt-codec.ts) so both serialize the same bytes */
import { bindTeamTopology } from "@bpmiq/live-client/tt-sync";
import { Modeler, NavigatedViewer } from "@miragon/team-topologies-renderer";

import { ttCodec } from "../../lib/tt-codec.ts";
import type { EngineFactory } from "../core/engine.ts";
import { type JsonEngine, type JsonRendererLike, mountJsonEngine } from "./tt.ts";

export const mountTeamTopologyEngine: EngineFactory<JsonEngine> = (container, readonly) =>
  mountJsonEngine({
    readonly,
    noun: "team-topology",
    editor: () => new Modeler({ container }) as unknown as JsonRendererLike,
    viewer: () => new NavigatedViewer({ container }) as unknown as JsonRendererLike,
    codec: ttCodec,
    bind: (m, ytext, doc, onConflict, onImportError) =>
      bindTeamTopology(m as never, ttCodec, ytext, doc, onConflict, onImportError),
  });
