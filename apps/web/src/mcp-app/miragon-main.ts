/**
 * The Miragon-renderer widget — ONE entry for every notation whose editor is
 * a Miragon modeler (wardley, team topology, event storming, context map).
 * The renderer spec rides in through the build-time alias
 * `@/mcp-app/widget-spec` (vite.widget.config.ts miragonWidgetConfig: one
 * single-file bundle per spec — exactly one engine per emitted file is the
 * widgets' whole CSS scoping; the dev server resolves it to widget-spec.dev.ts
 * for `/mcp-app-miragon.html?notation=<id>`). The engine is engines/miragon.ts
 * on the shared widget core: no extras, no icon font (the renderers draw
 * inline SVG), the file-route deep link (core/widget.ts defaults).
 */
import "./chrome.css";

import { byId } from "@bpmiq/notations";

import { spec } from "@/mcp-app/widget-spec";

import { bootWidget } from "./core/widget";
import { mountMiragonEngine } from "./engines/miragon";
import { el } from "./shell";

const notation = byId(spec.id);
if (!notation) throw new Error(`widget: no notation descriptor for renderer spec '${spec.id}'`);
document.title = `bpmiq ${notation.label} modeler`;
const noun = notation.noun.singular;

// the engine module is inlined into the bundle, so this resolves in a microtask
spec.load().then(
  (renderer) =>
    bootWidget({
      notation: spec.id,
      noun,
      engine: (container, readonly) => mountMiragonEngine(renderer, container, readonly),
    }),
  (err: unknown) => {
    el<HTMLDivElement>("status").textContent = `Modeler failed to load: ${(err as Error).message}`;
  },
);
