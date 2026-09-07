/**
 * The Miragon renderer spec — the ONE object per notation whose editor is a
 * Miragon modeler (the diagram-js renderers built from the modeler template:
 * wardley maps, team topologies, event storming, context maps). Everything
 * the platform needs to host such a renderer derives from it:
 *
 *   ./plugin.ts               → the web editor plugin (WebNotationPlugin)
 *   ../../mcp-app/engines/miragon.ts → the MCP-App widget engine
 *   ../../../vite.config.ts   → the SPA's vendor-CSS scoping (pkg + vendorRoot)
 *   ../../../scripts/build-widgets.ts → one single-file widget bundle per spec
 *
 * The eager part is DATA (id, package, css classes); the renderer, its
 * stylesheet and its text lane ride behind `load()` — the engine chunk loads
 * on mount in the SPA, and is inlined whole into the widget bundle. What
 * differs between the renderers is their text lane (@bpmiq/live-client
 * miragon-sync MiragonLane); issue #136 (@miragon/modeler-api) retires that
 * split upstream, after which a spec is `{ id, pkg, css, load }` alone.
 */
import type { DocumentModelerLike, DslModelerLike, MiragonLane } from "@bpmiq/live-client/miragon-sync";

/** a mounted Miragon renderer as the platform touches it — STRUCTURALLY
 *  (each renderer pins its own diagram-js copy; nothing may instanceof) */
export type MiragonRendererLike = (DslModelerLike | DocumentModelerLike) & { destroy(): void };

export interface MiragonRendererCtor {
  new (options: { container: HTMLElement; additionalModules?: unknown[] }): MiragonRendererLike;
}

/** what `load()` yields: the renderer package's editor + read-only viewer and
 *  the text lane the platform binds them through */
export interface LoadedMiragonRenderer {
  Modeler: MiragonRendererCtor;
  NavigatedViewer: MiragonRendererCtor;
  lane: MiragonLane;
}

export interface MiragonRendererSpec {
  /** must match a NotationDescriptor.id (@bpmiq/notations) — AND the spec
   *  file name `<id>.ts` (the widget build resolves the spec by id) */
  id: string;
  /** the renderer's npm package — the vendor-CSS scoping keys on it */
  pkg: string;
  /** css class of the canvas host (the SPA scopes the vendor sheet under it) */
  canvasClassName: string;
  /** the renderer's own root class, added to the SAME element as the canvas
   *  host class — the scoping prefixes it as a compound, not a descendant */
  vendorRoot: string;
  /** the engine: renderer module + stylesheet + text lane — lazy, so the
   *  SPA's eager bundle carries no engine */
  load(): Promise<LoadedMiragonRenderer>;
}
