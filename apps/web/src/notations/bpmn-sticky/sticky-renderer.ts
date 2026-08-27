/**
 * Sticky renderer (#117) — draws bpmiq:Sticky shapes: a colored square with
 * wrapped, centered text. Registered ABOVE the BpmnRenderer's priority;
 * BpmnRenderer never claims stickies anyway (canRender is bpmn:BaseElement-
 * gated), the priority just keeps the dispatch unambiguous.
 */
import BaseRenderer from "diagram-js/lib/draw/BaseRenderer";

import { isSticky, STICKY_COLORS, stickyKindOf } from "./sticky-model";

const PRIORITY = 1500;
const SVG_NS = "http://www.w3.org/2000/svg";

/** the slice of bpmn-js' TextRenderer we use (label line wrapping) */
interface TextRendererLike {
  createText(text: string, options: Record<string, unknown>): SVGElement;
}

interface ShapeLike {
  width: number;
  height: number;
  businessObject?: { text?: string };
}

const svg = (tag: string, attrs: Record<string, string | number>): SVGElement => {
  const el = document.createElementNS(SVG_NS, tag);
  for (const [key, value] of Object.entries(attrs)) el.setAttribute(key, String(value));
  return el;
};

export class StickyRenderer extends BaseRenderer {
  static $inject = ["eventBus", "textRenderer"];

  private readonly _textRenderer: TextRendererLike;

  constructor(eventBus: never, textRenderer: TextRendererLike) {
    super(eventBus, PRIORITY);
    this._textRenderer = textRenderer;
  }

  override canRender(element: unknown): boolean {
    return isSticky(element);
  }

  override drawShape(parentGfx: SVGElement, element: ShapeLike): SVGElement {
    const bo = element.businessObject ?? {};
    const { fill, stroke } = STICKY_COLORS[stickyKindOf(bo as never)];
    const rect = svg("rect", {
      x: 0,
      y: 0,
      width: element.width,
      height: element.height,
      rx: 3,
      fill,
      stroke,
      "stroke-width": 1,
      // a soft paper shadow (CSS filters apply to SVG) — the miro look
      style: "filter: drop-shadow(0 3px 6px rgba(0, 0, 0, 0.22))",
    });
    parentGfx.appendChild(rect);
    const label = this._textRenderer.createText(bo.text ?? "", {
      box: { width: element.width, height: element.height },
      padding: 8,
      align: "center-middle",
      style: { fill: "#333333" },
    });
    label.classList.add("djs-label");
    parentGfx.appendChild(label);
    return rect;
  }

  override getShapePath(shape: { x: number; y: number; width: number; height: number }): string {
    const { x, y, width, height } = shape;
    return `M${x},${y}l${width},0l0,${height}l${-width},0z`;
  }
}
