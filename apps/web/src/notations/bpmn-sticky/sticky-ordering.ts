/**
 * Sticky ordering (#117, design pass): stickies lie COMPLETELY ABOVE the
 * diagram — they are never children of pools/lanes/sub-processes (so a drop
 * can't grow a container via auto-resize, and lane moves don't carry them)
 * and they always render topmost.
 *
 * diagram-js' OrderingProvider intercepts shape.create/shape.move and lets
 * us override the PARENT and insertion INDEX: every sticky is re-homed to
 * the canvas root at the end of its child list (mixed moves decompose into
 * per-shape moves, so this holds there too); every non-sticky SHAPE landing
 * at a parent with stickies is inserted below the first sticky. Registered
 * after BpmnOrderingProvider, so sticky verdicts win.
 */
import OrderingProvider from "diagram-js/lib/features/ordering/OrderingProvider";

import { isSticky } from "./sticky-model";

interface ElementLike {
  children?: unknown[];
}
interface CanvasLike {
  getRootElement(): ElementLike;
}

export class StickyOrdering extends OrderingProvider {
  static override $inject = ["eventBus", "canvas"];

  private readonly _canvas: CanvasLike;

  constructor(eventBus: never, canvas: CanvasLike) {
    super(eventBus);
    this._canvas = canvas;
  }

  override getOrdering(element: unknown, _newParent: unknown): { parent?: unknown; index: number } | null {
    // ONLY the sticky branch lives here (parent = root, appended last).
    // Non-sticky elements return null: BpmnOrderingProvider already ran and
    // slots them below the stickies via their order level (stickies carry
    // level 11 — see StickyElementFactory) WITH its remove-before-reinsert
    // index compensation, which a naive override here would break.
    if (!isSticky(element)) return null;
    const root = this._canvas.getRootElement();
    return { parent: root, index: (root.children ?? []).length };
  }
}
