/** @miragon/context-maps-renderer — works on a typed CmDocument, so the text
 *  lane goes through the schema-model codec (parse: Zod-validated,
 *  non-throwing, migrating; serialize: sorted by id, rounded,
 *  version-stamped). importDocument leaves the command stack alone (verified
 *  in 0.2.0), so the document lane's rules apply unchanged. */
import { schemaModelCodec } from "./codec.ts";
import type { LoadedMiragonRenderer, MiragonRendererCtor, MiragonRendererSpec } from "./spec.ts";

export const spec: MiragonRendererSpec = {
  id: "context-map",
  pkg: "@miragon/context-maps-renderer",
  canvasClassName: "cm-canvas",
  vendorRoot: "cm-djs-container",
  async load(): Promise<LoadedMiragonRenderer> {
    const [{ Modeler, NavigatedViewer }, schema] = await Promise.all([
      import("@miragon/context-maps-renderer"),
      import("@miragon/context-maps-schema-model"),
      import("@miragon/context-maps-renderer/assets/context-maps.css"),
    ]);
    return {
      Modeler: Modeler as unknown as MiragonRendererCtor,
      NavigatedViewer: NavigatedViewer as unknown as MiragonRendererCtor,
      lane: { kind: "document", notation: "context-map", codec: schemaModelCodec(schema) },
    };
  },
};
