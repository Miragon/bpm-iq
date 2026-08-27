/**
 * Sticky UI surfaces (#117): the palette entry that creates a sticky, the
 * context pad that recolors (kind) and deletes one, and the direct-editing
 * provider for inline text — plus the t.BPM gesture: double-click on empty
 * canvas drops a sticky right there and opens its text editor.
 */
import {
  isSticky,
  isWorkshopMode,
  type ModdleLike,
  STICKY_COLORS,
  STICKY_KINDS,
  type StickyKind,
} from "./sticky-model";
import { STICKY_TYPE } from "./sticky-model";

/** inline SVG icon (data uri) — a sticky square with a folded corner */
function stickyIcon(fill: string, stroke: string): string {
  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24">` +
    `<path d="M3 3h18v13l-5 5H3z" fill="${fill}" stroke="${stroke}" stroke-width="1.6"/>` +
    `<path d="M21 16h-5v5" fill="none" stroke="${stroke}" stroke-width="1.6"/></svg>`;
  return `data:image/svg+xml,${encodeURIComponent(svg)}`;
}

// the PALETTE stays neutral (outline only) — colors belong to the canvas and
// the kind switcher, not the tool bar
const NEUTRAL = "#71717a";
const PALETTE_STICKY_ICON = stickyIcon("none", NEUTRAL);

/** the t.BPM toggle glyph: a sticky square with a mode dot */
const TBPM_ICON = `data:image/svg+xml,${encodeURIComponent(
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24">` +
    `<path d="M3 3h18v13l-5 5H3z" fill="none" stroke="${NEUTRAL}" stroke-width="1.6"/>` +
    `<circle cx="9" cy="11" r="2.4" fill="${NEUTRAL}"/><circle cx="15" cy="11" r="2.4" fill="none" stroke="${NEUTRAL}" stroke-width="1.4"/></svg>`,
)}`;

interface BpmnJsLike {
  getDefinitions(): ModdleLike | undefined;
}

interface ElementFactoryLike {
  create(elementType: "shape", attrs: Record<string, unknown>): unknown;
}
interface CreateLike {
  start(event: Event, shape: unknown): void;
}
interface ModelingLike {
  updateModdleProperties(element: unknown, moddleElement: unknown, properties: Record<string, unknown>): void;
  removeElements(elements: unknown[]): void;
  createShape(shape: unknown, position: { x: number; y: number }, target: unknown): unknown;
}

// ── palette ──────────────────────────────────────────────────────────────────

export class StickyPalette {
  static $inject = ["palette", "create", "elementFactory", "bpmnjs", "modeling", "canvas", "eventBus"];

  private readonly _create: CreateLike;
  private readonly _elementFactory: ElementFactoryLike;
  private readonly _bpmnjs: BpmnJsLike;
  private readonly _modeling: ModelingLike;
  private readonly _canvas: { getRootElement(): unknown };

  constructor(
    palette: { registerProvider(provider: unknown): void; _update(): void },
    create: CreateLike,
    elementFactory: ElementFactoryLike,
    bpmnjs: BpmnJsLike,
    modeling: ModelingLike,
    canvas: { getRootElement(): unknown },
    eventBus: { on(event: string, cb: () => void): void },
  ) {
    this._create = create;
    this._elementFactory = elementFactory;
    this._bpmnjs = bpmnjs;
    this._modeling = modeling;
    this._canvas = canvas;
    palette.registerProvider(this);
    // the entries depend on bpmiq:mode — refresh whenever it CHANGES, from
    // any direction: the toggle itself, its undo/redo (commandStack.changed)
    // or a remote flip (arrives via re-import)
    let lastMode: boolean | undefined;
    const maybeUpdate = (): void => {
      const workshop = isWorkshopMode(bpmnjs.getDefinitions());
      if (workshop === lastMode) return;
      lastMode = workshop;
      palette._update();
    };
    eventBus.on("import.done", maybeUpdate);
    eventBus.on("commandStack.changed", maybeUpdate);
  }

  getPaletteEntries(): Record<string, unknown> {
    const definitions = this._bpmnjs.getDefinitions();
    const workshop = isWorkshopMode(definitions);
    const entries: Record<string, unknown> = {
      // the t.BPM switch is a DOCUMENT property (bpmiq:mode) — flipping it
      // syncs to every participant; #54 builds the full mode UX on top
      "bpmiq-tbpm-toggle": {
        group: "tools",
        title: workshop ? "Leave t.BPM workshop mode" : "Enter t.BPM workshop mode (sticky notes)",
        className: workshop ? "bpmiq-tbpm-active" : "",
        imageUrl: TBPM_ICON,
        action: {
          click: () => {
            const defs = this._bpmnjs.getDefinitions();
            if (!defs) return;
            this._modeling.updateModdleProperties(this._canvas.getRootElement(), defs, {
              mode: isWorkshopMode(defs) ? undefined : "workshop",
            }); // palette refresh rides the commandStack.changed listener
          },
        },
      },
    };
    if (workshop) {
      const createSticky = (event: Event): void => {
        const shape = this._elementFactory.create("shape", { type: STICKY_TYPE });
        this._create.start(event, shape);
      };
      entries["create.bpmiq-sticky"] = {
        group: "artifact",
        title: "Create sticky note (discussion)",
        imageUrl: PALETTE_STICKY_ICON,
        action: { dragstart: createSticky, click: createSticky },
      };
    }
    return entries;
  }
}

// ── context pad ──────────────────────────────────────────────────────────────

/** runs AFTER the default providers: replaces whatever the BPMN pad offered
 *  for a sticky with the sticky's own actions (kinds + delete) */
export class StickyContextPad {
  static $inject = ["contextPad", "modeling"];

  private readonly _modeling: ModelingLike;

  constructor(contextPad: { registerProvider(priority: number, provider: unknown): void }, modeling: ModelingLike) {
    this._modeling = modeling;
    contextPad.registerProvider(400, this);
  }

  getContextPadEntries(element: unknown): unknown {
    if (!isSticky(element)) return {};
    const modeling = this._modeling;
    const entries: Record<string, unknown> = {};
    for (const kind of STICKY_KINDS) {
      entries[`sticky.kind-${kind}`] = {
        group: "edit",
        title: `Mark as ${kind}`,
        imageUrl: stickyIcon(STICKY_COLORS[kind].fill, STICKY_COLORS[kind].stroke),
        action: {
          click: () =>
            modeling.updateModdleProperties(element, (element as { businessObject: unknown }).businessObject, { kind }),
        },
      };
    }
    entries["delete"] = {
      group: "edit",
      title: "Remove sticky",
      className: "bpmn-icon-trash",
      action: { click: () => modeling.removeElements([element]) },
    };
    // replace, don't merge: the BPMN pad's append/connect tools make no sense
    // on a discussion artifact
    return () => entries;
  }
}

// ── direct editing + double-click-to-create ──────────────────────────────────

interface CanvasLike {
  getRootElement(): unknown;
  getAbsoluteBBox(element: unknown): { x: number; y: number; width: number; height: number };
  getContainer(): HTMLElement;
  viewbox(): { x: number; y: number; scale: number };
  zoom(): number;
}
interface RegistryLike {
  filter(fn: (element: never) => boolean): Array<{ x: number; y: number; width: number; height: number }>;
}

export class StickyEditing {
  static $inject = ["directEditing", "eventBus", "canvas", "modeling", "elementFactory", "elementRegistry", "bpmnjs"];

  private readonly _canvas: CanvasLike;
  private readonly _modeling: ModelingLike;

  constructor(
    directEditing: {
      registerProvider(provider: unknown): void;
      activate(element: unknown): unknown;
      isActive(element?: unknown): boolean;
      getValue(): string;
      cancel(): void;
    },
    eventBus: { on(event: string, cb: (event: { element: unknown; originalEvent?: MouseEvent }) => void): void },
    canvas: CanvasLike,
    modeling: ModelingLike,
    elementFactory: ElementFactoryLike,
    elementRegistry: RegistryLike,
    bpmnjs: BpmnJsLike,
  ) {
    this._canvas = canvas;
    this._modeling = modeling;
    directEditing.registerProvider(this);

    // a REMOTE re-import tears the canvas down mid-edit — without this the
    // half-typed sticky text is silently discarded (review #117). Stash the
    // in-flight value before the import and re-apply it as a LOCAL edit
    // afterwards; if the sticky was deleted remotely, the remote wins.
    let inFlight: { id: string; text: string } | null = null;
    eventBus.on("import.parse.start", () => {
      const de = directEditing as unknown as { _active?: { element?: { id?: string } } };
      if (!directEditing.isActive() || !isSticky(de._active?.element)) return;
      const id = de._active?.element?.id;
      if (typeof id === "string") inFlight = { id, text: directEditing.getValue() };
      directEditing.cancel();
    });
    eventBus.on("import.done", () => {
      if (!inFlight) return;
      const { id, text } = inFlight;
      inFlight = null;
      const element = (elementRegistry as unknown as { get(id: string): unknown }).get(id);
      if (!element || !isSticky(element)) return; // deleted remotely — remote wins
      const bo = (element as { businessObject: { text?: string } }).businessObject;
      if (bo.text !== text) modeling.updateModdleProperties(element, bo, { text });
    });

    // t.BPM gesture: double-click on EMPTY canvas creates a sticky there.
    // Element double-clicks (incl. on stickies) go through the provider chain.
    eventBus.on("element.dblclick", (event) => {
      if (event.element !== canvas.getRootElement() || !event.originalEvent) return;
      // sticky creation is a WORKSHOP gesture (bpmiq:mode)
      if (!isWorkshopMode(bpmnjs.getDefinitions())) return;
      // not on a drilldown plane: sticky coordinates are main-plane absolute
      const rootBo = (event.element as { businessObject?: { $type?: string } }).businessObject;
      if (rootBo?.$type === "bpmn:SubProcess") return;
      const rect = canvas.getContainer().getBoundingClientRect();
      const vb = canvas.viewbox();
      const scale = vb.scale || 1;
      const position = {
        x: Math.round(vb.x + (event.originalEvent.clientX - rect.left) / scale),
        y: Math.round(vb.y + (event.originalEvent.clientY - rect.top) / scale),
      };
      // stickies float above the diagram — the root is always the target
      const shape = elementFactory.create("shape", { type: STICKY_TYPE });
      const created = modeling.createShape(shape, position, canvas.getRootElement());
      if (created) directEditing.activate(created);
    });
  }

  /** direct-editing provider: claim stickies (the label provider returns
   *  undefined for them — no bpmn label), edit their `text` */
  activate(element: unknown): Record<string, unknown> | undefined {
    if (!isSticky(element)) return undefined;
    const bo = (element as { businessObject: { text?: string; kind?: string } }).businessObject;
    const bounds = this._canvas.getAbsoluteBBox(element);
    const zoom = this._canvas.zoom();
    const kind = ((bo.kind ?? "note") as StickyKind) in STICKY_COLORS ? ((bo.kind ?? "note") as StickyKind) : "note";
    return {
      bounds,
      text: bo.text ?? "",
      style: {
        backgroundColor: STICKY_COLORS[kind].fill,
        fontSize: `${Math.round(12 * zoom)}px`,
        lineHeight: 1.25,
        textAlign: "center",
      },
      options: { centerVertically: true },
    };
  }

  update(element: unknown, newText: string): void {
    const bo = (element as { businessObject: unknown }).businessObject;
    this._modeling.updateModdleProperties(element, bo, { text: newText });
  }
}
