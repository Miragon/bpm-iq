/**
 * Sticky resize preview (#188) — diagram-js previews a resize as an empty
 * dashed frame and redraws the shape only on release. For a sticky that hides
 * exactly what the resize is about, so the frame gets the sticky itself drawn
 * at the new size, its text re-fitted on every move, while the original steps
 * aside (sticky.css). The drag also stops at STICKY_MIN instead of running on
 * into a rejected frame.
 */
import { isSticky, STICKY_MIN } from "./sticky-model";
import type { StickyRenderer } from "./sticky-renderer";

const SVG_NS = "http://www.w3.org/2000/svg";
/** before diagram-js' Resize (1000) computes the constraints from minDimensions */
const START_PRIORITY = 1500;
/** after ResizePreview (500) has placed its frame */
const MOVE_PRIORITY = 250;

interface ResizeContext {
  shape: unknown;
  newBounds?: { x: number; y: number; width: number; height: number };
  minDimensions?: { width: number; height: number };
  /** diagram-js' dashed preview frame */
  frame?: SVGElement;
  stickyPreview?: SVGGElement;
}

interface EventBusLike {
  on(event: string, priority: number, cb: (event: { context: ResizeContext }) => void): void;
  on(event: string, cb: (event: { context: ResizeContext }) => void): void;
}

export class StickyResizePreview {
  static $inject = ["eventBus", "canvas", "stickyRenderer"];

  constructor(eventBus: EventBusLike, canvas: { getActiveLayer(): SVGElement }, stickyRenderer: StickyRenderer) {
    eventBus.on("resize.start", START_PRIORITY, ({ context }) => {
      if (isSticky(context.shape)) context.minDimensions = { ...STICKY_MIN };
    });

    eventBus.on("resize.move", MOVE_PRIORITY, ({ context }) => {
      const { shape, newBounds: bounds } = context;
      if (!isSticky(shape) || !bounds) return;
      let preview = context.stickyPreview;
      if (!preview) {
        preview = context.stickyPreview = document.createElementNS(SVG_NS, "g");
        preview.classList.add("bpmiq-sticky-resize-preview");
        // below the dashed frame, so the frame still reads as the resize handle
        const frame = context.frame;
        if (frame?.parentNode) frame.parentNode.insertBefore(preview, frame);
        else canvas.getActiveLayer().appendChild(preview);
      }
      preview.replaceChildren();
      preview.setAttribute("transform", `translate(${bounds.x}, ${bounds.y})`);
      stickyRenderer.drawShape(preview, {
        width: bounds.width,
        height: bounds.height,
        businessObject: shape.businessObject,
      });
    });

    eventBus.on("resize.cleanup", ({ context }) => {
      context.stickyPreview?.remove();
      context.stickyPreview = undefined;
    });
  }
}
