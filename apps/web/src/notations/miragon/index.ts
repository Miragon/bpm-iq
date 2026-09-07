/**
 * The Miragon renderer registry — the web-side twin of @bpmiq/notations for
 * the notations whose editor is a Miragon modeler: ONE spec per renderer,
 * everything else derives (see ./spec.ts for the four consumers). Adding a
 * Miragon notation = its descriptor in @bpmiq/notations + one spec file here
 * (named `<id>.ts`, exporting `spec` — the widget build aliases it in by id)
 * + the id in the Live Host's widget list (apps/live-host/src/http/mcp.ts).
 *
 * Node-loadable on purpose (scripts/build-widgets.ts and vite.config.ts
 * import it): relative `.ts` imports, no "@/" alias, nothing DOM-bound at
 * module level — the engines load behind each spec's `load()`.
 */
import { spec as contextMap } from "./context-map.ts";
import { spec as eventStorming } from "./event-storming.ts";
import type { MiragonRendererSpec } from "./spec.ts";
import { spec as teamTopology } from "./team-topology.ts";
import { spec as wardley } from "./wardley.ts";

export type { LoadedMiragonRenderer, MiragonRendererLike, MiragonRendererSpec } from "./spec.ts";

export const MIRAGON_RENDERERS: readonly MiragonRendererSpec[] = [wardley, teamTopology, eventStorming, contextMap];
