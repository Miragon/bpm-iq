/**
 * Sticky persistence (#117) — the bridge between canvas shapes and the
 * `<bpmiq:sticky/>` extension elements in the .bpmn:
 *
 *  - import.done  → rebuild sticky shapes from every process's
 *    extensionElements (importXML wipes the canvas; the extension elements
 *    ARE the truth, coordinates included — no BPMNDI involved)
 *  - shape.create/delete/move, spaceTool, updateAttachment → mirror into the
 *    extension elements INSIDE the same command transaction (postExecute):
 *    one user action = one command-stack entry = one bpmn-sync export, and
 *    undo reverts canvas AND XML atomically
 *
 * Canonical order (sorted by sticky id, non-sticky extensions untouched)
 * makes concurrent sessions converge to identical XML.
 */
import CommandInterceptor from "diagram-js/lib/command/CommandInterceptor";

import { isSticky, type ModdleLike, processesOf, stickiesOf, type StickyModdle } from "./sticky-model";
import { STICKY_SIZE, STICKY_TYPE } from "./sticky-model";

interface ShapeLike {
  id: string;
  x: number;
  y: number;
  width: number;
  height: number;
  parent?: ShapeLike;
  host?: ShapeLike | null;
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
    // every command that can move a sticky (directly, or carried by its lane/
    // pool/host) — a cheap full sweep keeps x/y AND process ownership
    // truthful without per-command bookkeeping
    this.postExecute(["shape.move", "elements.move", "spaceTool"], () => this._syncStickies());
    this.postExecute(
      "element.updateAttachment",
      (event: { context: { shape?: ShapeLike; newHost?: ShapeLike | null } }) => {
        const { shape, newHost } = event.context;
        if (!shape || !isSticky(shape)) return;
        const hostId = newHost?.businessObject?.id;
        this._modeling.updateModdleProperties(shape, shape.businessObject, {
          attachedTo: typeof hostId === "string" ? hostId : undefined,
        });
      },
    );
  }

  /** the bpmn:Process whose extensionElements own a sticky at this canvas spot */
  private _processFor(shape: ShapeLike): ModdleLike | undefined {
    for (let el: ShapeLike | undefined = shape.parent; el; el = el.parent) {
      const bo = el.businessObject;
      if (!bo) continue;
      if (bo.$type === "bpmn:Process") return bo;
      if (bo.$type === "bpmn:Participant" && bo.processRef) return bo.processRef as ModdleLike;
      if (bo.$type === "bpmn:Lane") {
        // lane → laneSet → process
        for (let p = bo.$parent; p; p = p.$parent) if (p.$type === "bpmn:Process") return p;
      }
    }
    // free-floating on a collaboration canvas — fall back to the first process
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

  private _syncStickies(): void {
    for (const shape of this._registry.filter((el) => isSticky(el))) {
      const bo = shape.businessObject as StickyModdle;
      const x = Math.round(shape.x);
      const y = Math.round(shape.y);
      if (bo.x !== x || bo.y !== y) this._modeling.updateModdleProperties(shape, bo, { x, y });
      // cross-pool move: the sticky now lives under ANOTHER process — re-home
      // its extension element, or deleting the old pool would drop it
      const process = this._processFor(shape);
      if (process && bo.$parent && bo.$parent.$parent !== process) {
        this._removeFromOwner(shape, bo);
        this._addToProcess(shape, bo, process);
      }
    }
  }

  /** importXML wiped the canvas — recreate sticky shapes from the tree.
   *  canvas.addShape (no commands): an import must not dirty the undo stack. */
  private _rebuild(): void {
    const definitions = this._bpmnjs.getDefinitions();
    if (!definitions) return;
    const root = this._canvas.getRootElement();
    for (const process of processesOf(definitions)) {
      for (const sticky of stickiesOf(process)) {
        // a malformed entry (hand-edited, remote mid-merge) renders nothing
        // but STAYS in the XML — never destroy what we cannot draw
        if (!Number.isFinite(sticky.x) || !Number.isFinite(sticky.y) || typeof sticky.id !== "string") continue;
        if (this._registry.get(sticky.id)) continue; // defensive: never add twice
        const host = typeof sticky.attachedTo === "string" ? this._registry.get(sticky.attachedTo) : undefined;
        const parent = host?.parent ?? this._containerAt(sticky.x as number, sticky.y as number) ?? root;
        const shape = this._elementFactory.create("shape", {
          type: STICKY_TYPE,
          businessObject: sticky,
          x: sticky.x,
          y: sticky.y,
          ...STICKY_SIZE,
          ...(host ? { host } : {}),
        });
        this._canvas.addShape(shape, parent);
      }
    }
  }

  /** deepest participant/lane whose bounds contain the sticky center — lane
   *  parenting survives re-imports because it is derived, not persisted */
  private _containerAt(x: number, y: number): ShapeLike | undefined {
    const cx = x + STICKY_SIZE.width / 2;
    const cy = y + STICKY_SIZE.height / 2;
    return this._registry
      .filter((el) => {
        const type = el.businessObject?.$type;
        if (type !== "bpmn:Participant" && type !== "bpmn:Lane") return false;
        return cx >= el.x && cx <= el.x + el.width && cy >= el.y && cy <= el.y + el.height;
      })
      .sort((a, b) => a.width * a.height - b.width * b.height)[0];
  }
}
