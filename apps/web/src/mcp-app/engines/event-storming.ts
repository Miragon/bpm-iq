/** the Event Storming widget engine — @miragon/event-storming-renderer over
 *  the shared DSL engine; the view-options event is a display preference,
 *  never content, so only the command stack counts as an edit */
import { bindEventStorming } from "@bpmiq/live-client/event-storming-sync";
import { Modeler, NavigatedViewer } from "@miragon/event-storming-renderer";

import type { EngineFactory } from "../core/engine.ts";
import { type DslEngine, type DslRendererLike, mountDslEngine } from "./dsl.ts";

export const mountEventStormingEngine: EngineFactory<DslEngine> = (container, readonly) =>
  mountDslEngine({
    readonly,
    editor: () => new Modeler({ container }) as unknown as DslRendererLike,
    viewer: (additionalModules) =>
      new NavigatedViewer({ container, additionalModules: additionalModules as never }) as unknown as DslRendererLike,
    changeEvents: ["commandStack.changed"],
    bind: bindEventStorming as never,
  });
