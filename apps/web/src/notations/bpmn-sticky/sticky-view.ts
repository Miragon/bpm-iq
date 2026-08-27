/**
 * The RENDER-ONLY sticky subset (#117): renderer + import rebuild, nothing
 * else — for bpmn-js VIEWERS (the readonly MCP-App widget). The full edit
 * module injects services a viewer does not register (modeling, palette,
 * directEditing, bpmnFactory) and would fail DI on mount; this one runs on
 * the viewer's diagram-js base elementFactory (attrs passed through 1:1,
 * which is why the id/size land explicitly in the attrs).
 */
import { type ModdleLike, processesOf, stickiesOf, STICKY_SIZE, STICKY_TYPE } from "./sticky-model";
import { StickyRenderer } from "./sticky-renderer";

interface ElementFactoryLike {
  create(elementType: "shape", attrs: Record<string, unknown>): unknown;
}
interface CanvasLike {
  getRootElement(): unknown;
  addShape(shape: unknown, parent: unknown): unknown;
}
interface RegistryLike {
  get(id: string): unknown;
}
interface BpmnJsLike {
  getDefinitions(): ModdleLike | undefined;
}

export interface StickyRebuildDeps {
  bpmnjs: BpmnJsLike;
  elementFactory: ElementFactoryLike;
  canvas: CanvasLike;
  elementRegistry: RegistryLike;
}

/** recreate sticky shapes from the extension elements — importXML wiped the
 *  canvas; malformed entries render nothing but STAY in the XML. Shared by
 *  the edit module's persistence and the viewer's import hook. */
export function rebuildStickyShapes({ bpmnjs, elementFactory, canvas, elementRegistry }: StickyRebuildDeps): void {
  const definitions = bpmnjs.getDefinitions();
  if (!definitions) return;
  const root = canvas.getRootElement();
  for (const process of processesOf(definitions)) {
    for (const sticky of stickiesOf(process)) {
      if (!Number.isFinite(sticky.x) || !Number.isFinite(sticky.y) || typeof sticky.id !== "string") continue;
      if (elementRegistry.get(sticky.id)) continue; // defensive: never add twice
      const shape = elementFactory.create("shape", {
        type: STICKY_TYPE,
        id: sticky.id,
        businessObject: sticky,
        x: sticky.x,
        y: sticky.y,
        width: Number.isFinite(sticky.width) ? (sticky.width as number) : STICKY_SIZE.width,
        height: Number.isFinite(sticky.height) ? (sticky.height as number) : STICKY_SIZE.height,
        // stickies render above everything (BpmnOrderingProvider reads this)
        order: { level: 11 },
      });
      // stickies float above the diagram — always root children
      canvas.addShape(shape, root);
    }
  }
}

export class StickyViewImport {
  static $inject = ["eventBus", "bpmnjs", "canvas", "elementFactory", "elementRegistry"];

  constructor(
    eventBus: { on(event: string, cb: (event?: unknown) => void): void },
    bpmnjs: BpmnJsLike,
    canvas: CanvasLike,
    elementFactory: ElementFactoryLike,
    elementRegistry: RegistryLike,
  ) {
    eventBus.on("import.done", (event?: unknown) => {
      if ((event as { error?: unknown } | undefined)?.error) return;
      rebuildStickyShapes({ bpmnjs, elementFactory, canvas, elementRegistry });
    });
  }
}

/** viewer module: pass via additionalModules on a NavigatedViewer (plus the
 *  bpmiq moddle extension) — stickies render, nothing is editable */
export const bpmnStickyViewModule = {
  __init__: ["stickyRenderer", "stickyViewImport"],
  stickyRenderer: ["type", StickyRenderer],
  stickyViewImport: ["type", StickyViewImport],
};
