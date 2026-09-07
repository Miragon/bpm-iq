/** @miragon/team-topologies-renderer — works on a typed TtDocument, so the
 *  text lane goes through the schema-model codec (parse: Zod-validated,
 *  non-throwing; serialize: deterministic) */
import { schemaModelCodec } from "./codec.ts";
import type { LoadedMiragonRenderer, MiragonRendererCtor, MiragonRendererSpec } from "./spec.ts";

export const spec: MiragonRendererSpec = {
  id: "team-topology",
  pkg: "@miragon/team-topologies-renderer",
  canvasClassName: "tt-canvas",
  vendorRoot: "tt-djs-container",
  async load(): Promise<LoadedMiragonRenderer> {
    const [{ Modeler, NavigatedViewer }, schema] = await Promise.all([
      import("@miragon/team-topologies-renderer"),
      import("@miragon/team-topologies-schema-model"),
      import("@miragon/team-topologies-renderer/assets/team-topologies.css"),
    ]);
    return {
      Modeler: Modeler as unknown as MiragonRendererCtor,
      NavigatedViewer: NavigatedViewer as unknown as MiragonRendererCtor,
      lane: { kind: "document", notation: "team-topology", codec: schemaModelCodec(schema) },
    };
  },
};
