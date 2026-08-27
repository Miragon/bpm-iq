/**
 * Sticky persistence (#117) — the bridge between canvas shapes and the
 * `<bpmiq:sticky/>` extension elements in the .bpmn:
 *
 *  - import.done  → rebuild sticky shapes from every process's
 *    extensionElements (importXML wipes the canvas; the extension elements
 *    ARE the truth, coordinates included — no BPMNDI involved)
 *  - shape.create/delete/move/resize, spaceTool → mirror into the extension
 *    elements INSIDE the same command transaction (postExecute):
 *    one user action = one command-stack entry = one bpmn-sync export, and
 *    undo reverts canvas AND XML atomically
 *
 * Canonical order (sorted by sticky id, non-sticky extensions untouched)
 * makes concurrent sessions converge to identical XML.
 */
import CommandInterceptor from "diagram-js/lib/command/CommandInterceptor";

import { isSticky, type ModdleLike, processesOf, type StickyModdle } from "./sticky-model";
import { rebuildStickyShapes } from "./sticky-view";

interface ShapeLike {
  id: string;
  x: number;
  y: number;
  width: number;
  height: number;
  parent?: ShapeLike;
  businessObject?: ModdleLike;
}

interface CanvasLike {
  getRootElement(): ShapeLike;
  getRootElements(): Array<{ di?: { get(name: string): unknown[]; set(name: string, value: unknown[]): void } }>;
  addShape(shape: unknown, parent: unknown): unknown;
}
interface RegistryLike {
  get(id: string): ShapeLike | undefined;
  filter(fn: (element: ShapeLike) => boolean): ShapeLike[];
}
interface ModelingLike {
  updateModdleProperties(element: unknown, moddleElement: unknown, properties: Record<string, unknown>): void;
}
interface BpmnJsLike {
  getDefinitions(): ModdleLike | undefined;
}
interface FactoryLike {
  create(elementType: "shape", attrs: Record<string, unknown>): ShapeLike;
}
interface BpmnFactoryLike {
  create(type: string, attrs?: Record<string, unknown>): ModdleLike;
}

export class StickyPersistence extends CommandInterceptor {
  static override $inject = [
    "eventBus",
    "bpmnjs",
    "canvas",
    "elementFactory",
    "elementRegistry",
    "modeling",
    "bpmnFactory",
  ];

  private readonly _bpmnjs: BpmnJsLike;
  private readonly _canvas: CanvasLike;
  private readonly _elementFactory: FactoryLike;
  private readonly _registry: RegistryLike;
  private readonly _modeling: ModelingLike;
  private readonly _bpmnFactory: BpmnFactoryLike;

  constructor(
    eventBus: { on(event: string, cb: () => void): void },
    bpmnjs: BpmnJsLike,
    canvas: CanvasLike,
    elementFactory: FactoryLike,
    elementRegistry: RegistryLike,
    modeling: ModelingLike,
    bpmnFactory: BpmnFactoryLike,
  ) {
    super(eventBus as never);
    this._bpmnjs = bpmnjs;
    this._canvas = canvas;
    this._elementFactory = elementFactory;
    this._registry = elementRegistry;
    this._modeling = modeling;
    this._bpmnFactory = bpmnFactory;

    eventBus.on("import.done", (event?: unknown) => {
      // a FAILED import leaves the previous canvas standing — rebuilding on
      // top of it would duplicate every sticky shape
      if ((event as { error?: unknown } | undefined)?.error) return;
      this._rebuild();
    });

    // BLOCKER guard (review #117): bpmn-js' BpmnDiOrdering (saveXML.start,
    // priority 2000) rebuilds every plane's planeElement list as
    // map(children, getDi) — DI-LESS stickies leave `undefined` holes that
    // make moddle's toXML THROW, silently losing every export after the
    // first sticky appears. This listener runs AFTER it (default priority)
    // and drops the holes.
    (eventBus as unknown as { on(event: string, priority: number, cb: () => void): void }).on(
      "saveXML.start",
      1000,
      () => {
        for (const root of this._canvas.getRootElements()) {
          const di = root.di;
          if (!di) continue;
          const list = di.get("planeElement");
          if (Array.isArray(list) && list.some((d) => !d)) di.set("planeElement", list.filter(Boolean));
        }
      },
    );

    this.postExecute("shape.create", (event: { context: { shape?: ShapeLike } }) => {
      const shape = event.context.shape;
      if (shape && isSticky(shape)) this._persistCreate(shape);
    });
    this.postExecute("shape.delete", (event: { context: { shape?: ShapeLike } }) => {
      const shape = event.context.shape;
      if (shape && isSticky(shape)) this._persistDelete(shape);
    });
    // deleting a POOL removes its process from the document — stickies are
    // root children now (they never die with the pool), so any sticky whose
    // owning process just left the tree is re-homed to a surviving process
    // (or removed with it, when none survives)
    this.postExecuted("shape.delete", (event: { context: { shape?: ShapeLike } }) => {
      const bo = event.context.shape?.businessObject;
      if (bo?.$type !== "bpmn:Participant") return;
      this._rehomeOrphans();
    });
    // every command that can move or resize a sticky — a cheap full sweep
    // keeps x/y/width/height truthful without per-command bookkeeping
    this.postExecute(["shape.move", "elements.move", "shape.resize", "spaceTool"], () => this._syncStickies());
  }

  /** stickies FLOAT above the diagram (root children, StickyOrdering) — the
   *  owning process is simply the canvas root's process, or the first one on
   *  a collaboration */
  private _processFor(shape: ShapeLike): ModdleLike | undefined {
    const rootBo = (shape.parent ?? this._canvas.getRootElement()).businessObject;
    if (rootBo?.$type === "bpmn:Process") return rootBo;
    const definitions = this._bpmnjs.getDefinitions();
    return definitions ? processesOf(definitions)[0] : undefined;
  }

  /** append the sticky to a process's extensionElements (creating those if
   *  needed) — always inside the surrounding command transaction */
  private _addToProcess(shape: ShapeLike, bo: StickyModdle, process: ModdleLike): void {
    let ext = process.extensionElements as ModdleLike | undefined;
    if (!ext) {
      ext = this._bpmnFactory.create("bpmn:ExtensionElements", { values: [] });
      ext.$parent = process;
      this._modeling.updateModdleProperties(shape, process, { extensionElements: ext });
    }
    bo.$parent = ext;
    const values = (ext.values as ModdleLike[] | undefined) ?? [];
    if (!values.includes(bo)) {
      this._modeling.updateModdleProperties(shape, ext, { values: [...values, bo] });
    }
  }

  /** remove the sticky from its current extensionElements; a container left
   *  EMPTY is cleared entirely — the file returns to its pre-workshop state */
  private _removeFromOwner(markElement: unknown, bo: StickyModdle): void {
    const ext = bo.$parent;
    const values = ext?.values as ModdleLike[] | undefined;
    if (!ext || !values || !values.includes(bo)) return;
    const remaining = values.filter((v) => v !== bo);
    if (remaining.length === 0 && ext.$parent) {
      this._modeling.updateModdleProperties(markElement, ext.$parent, { extensionElements: undefined });
    } else {
      this._modeling.updateModdleProperties(markElement, ext, { values: remaining });
    }
  }

  private _persistCreate(shape: ShapeLike): void {
    const process = this._processFor(shape);
    const bo = shape.businessObject as StickyModdle | undefined;
    if (!process || !bo) return;
    this._modeling.updateModdleProperties(shape, bo, {
      x: Math.round(shape.x),
      y: Math.round(shape.y),
      width: Math.round(shape.width),
      height: Math.round(shape.height),
      kind: bo.kind ?? "note",
      text: bo.text ?? "",
    });
    this._addToProcess(shape, bo, process);
  }

  private _persistDelete(shape: ShapeLike): void {
    const bo = shape.businessObject as StickyModdle | undefined;
    // the shape is gone from the registry — mark the change on the root
    if (bo) this._removeFromOwner(this._canvas.getRootElement(), bo);
  }

  /** true when the sticky's extension element still hangs off the document */
  private _isInDocument(bo: StickyModdle): boolean {
    for (let p = bo.$parent; p; p = p.$parent) if (p.$type === "bpmn:Definitions") return true;
    return false;
  }

  private _rehomeOrphans(): void {
    const definitions = this._bpmnjs.getDefinitions();
    if (!definitions) return;
    const survivor = processesOf(definitions)[0];
    for (const shape of this._registry.filter((el) => isSticky(el))) {
      const bo = shape.businessObject as StickyModdle;
      if (this._isInDocument(bo)) continue;
      if (survivor) {
        bo.$parent = undefined; // detached with its old process — re-append
        this._addToProcess(shape, bo, survivor);
      } else {
        // nothing left to persist to — the sticky dies with the last pool
        (this._modeling as unknown as { removeElements(elements: unknown[]): void }).removeElements([shape]);
      }
    }
  }

  private _syncStickies(): void {
    for (const shape of this._registry.filter((el) => isSticky(el))) {
      const bo = shape.businessObject as StickyModdle;
      const next = {
        x: Math.round(shape.x),
        y: Math.round(shape.y),
        width: Math.round(shape.width),
        height: Math.round(shape.height),
      };
      if (bo.x !== next.x || bo.y !== next.y || bo.width !== next.width || bo.height !== next.height) {
        this._modeling.updateModdleProperties(shape, bo, next);
      }
    }
  }

  /** importXML wiped the canvas — recreate sticky shapes from the tree
   *  (shared with the viewer module; canvas.addShape, no commands: an import
   *  must not dirty the undo stack) */
  private _rebuild(): void {
    rebuildStickyShapes({
      bpmnjs: this._bpmnjs,
      elementFactory: this._elementFactory,
      canvas: this._canvas,
      elementRegistry: this._registry,
    });
  }
}
