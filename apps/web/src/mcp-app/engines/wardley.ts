/** the Wardley Map widget engine — @miragon/wardley-renderer over the shared
 *  DSL engine; 'wardley.config.changed' (the evolution axis labels) is
 *  content, so it counts as an edit exactly like the live binding treats it */
import { bindWardley } from "@bpmiq/live-client/wardley-sync";
import { Modeler, NavigatedViewer } from "@miragon/wardley-renderer";

import type { EngineFactory } from "../core/engine.ts";
import { type DslEngine, type DslRendererLike, mountDslEngine } from "./dsl.ts";

export const mountWardleyEngine: EngineFactory<DslEngine> = (container, readonly) =>
  mountDslEngine({
    readonly,
    editor: () => new Modeler({ container }) as unknown as DslRendererLike,
    viewer: (additionalModules) =>
      new NavigatedViewer({ container, additionalModules: additionalModules as never }) as unknown as DslRendererLike,
    changeEvents: ["commandStack.changed", "wardley.config.changed"],
    bind: bindWardley as never,
  });
