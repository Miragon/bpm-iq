/** the Context Map widget engine — @miragon/context-maps-renderer over the
 *  shared JSON engine, with the ONE codec the SPA editor uses too
 *  (lib/cm-codec.ts) so both serialize the same bytes; importDocument leaves
 *  the command stack alone (verified in 0.2.0), so the JSON engine's rules
 *  apply unchanged: silent clear on the editable mount, no shim on the viewer */
import { bindContextMap } from "@bpmiq/live-client/context-map-sync";
import { Modeler, NavigatedViewer } from "@miragon/context-maps-renderer";

import { cmCodec } from "../../lib/cm-codec.ts";
import type { EngineFactory } from "../core/engine.ts";
import { type JsonEngine, type JsonRendererLike, mountJsonEngine } from "./tt.ts";

export const mountContextMapEngine: EngineFactory<JsonEngine> = (container, readonly) =>
  mountJsonEngine({
    readonly,
    noun: "context-map",
    editor: () => new Modeler({ container }) as unknown as JsonRendererLike,
    viewer: () => new NavigatedViewer({ container }) as unknown as JsonRendererLike,
    codec: cmCodec,
    bind: (m, ytext, doc, onConflict, onImportError) =>
      bindContextMap(m as never, cmCodec, ytext, doc, onConflict, onImportError),
  });
