/**
 * Sticky renderer (#117) — draws bpmiq:Sticky shapes: a colored square with
 * wrapped, centered text. Registered ABOVE the BpmnRenderer's priority;
 * BpmnRenderer never claims stickies anyway (canRender is bpmn:BaseElement-
 * gated), the priority just keeps the dispatch unambiguous.
 *
 * The text auto-fits the note (#188, sticky-text.ts): the renderer lays the
 * lines out itself in the diagram's label font — bpmn-js' TextRenderer only
 * wraps at a fixed size and cuts long words without a hyphen.
 */
import BaseRenderer from "diagram-js/lib/draw/BaseRenderer";

import { isSticky, STICKY_COLORS, stickyKindOf } from "./sticky-model";
import {
  fitStickyText,
  type MeasureText,
  STICKY_TEXT_DEFAULTS,
  type StickyTextLayout,
  type StickyTextOptions,
} from "./sticky-text";

const PRIORITY = 1500;
const SVG_NS = "http://www.w3.org/2000/svg";

/** the slice of bpmn-js' TextRenderer we use: the diagram's label font */
interface TextRendererLike {
  getDefaultStyle(): { fontFamily: string; fontSize: number | string; fontWeight?: string; lineHeight?: number };
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

/** canvas text metrics in the label font — the same measure diagram-js'
 *  label layout uses; without a canvas (headless) a generous estimate */
function canvasMeasure(fontFamily: string, fontWeight: string): MeasureText {
  const ctx = document.createElement("canvas").getContext("2d");
  if (!ctx) return (text, fontSize) => Array.from(text).length * fontSize * 0.6;
  let font = "";
  return (text, fontSize) => {
    const next = `${fontWeight} ${fontSize}px ${fontFamily}`;
    if (next !== font) ctx.font = font = next;
    return ctx.measureText(text).width;
  };
}

export class StickyRenderer extends BaseRenderer {
  static $inject = ["eventBus", "textRenderer"];

  /** the label font, as the note's text is drawn */
  readonly font: { family: string; weight: string };
  readonly textOptions: StickyTextOptions;
  private _measure: MeasureText | undefined;

  constructor(eventBus: never, textRenderer: TextRendererLike) {
    super(eventBus, PRIORITY);
    const style = textRenderer.getDefaultStyle();
    this.font = { family: style.fontFamily, weight: style.fontWeight ?? "normal" };
    // the text grows back up to the diagram's default label size, never beyond
    this.textOptions = {
      ...STICKY_TEXT_DEFAULTS,
      maxFontSize: Number.parseFloat(String(style.fontSize)) || STICKY_TEXT_DEFAULTS.maxFontSize,
      lineHeight: style.lineHeight ?? STICKY_TEXT_DEFAULTS.lineHeight,
    };
  }

  override canRender(element: unknown): boolean {
    return isSticky(element);
  }

  /** the text layout a note of this size shows — derived, never stored */
  fitText(text: string, box: { width: number; height: number }): StickyTextLayout {
    this._measure ??= canvasMeasure(this.font.family, this.font.weight);
    return fitStickyText(text, box, this._measure, this.textOptions);
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
    rect.classList.add("designiq-sticky-note");
    parentGfx.appendChild(rect);

    const layout = this.fitText(bo.text ?? "", element);
    const label = svg("text", {
      "font-family": this.font.family,
      "font-size": layout.fontSize,
      "font-weight": this.font.weight,
      fill: "#333333",
      "text-anchor": "middle",
    });
    label.classList.add("djs-label", "designiq-sticky-text");
    // the block centers vertically; a baseline sits 3/4 down its line (the
    // offset diagram-js' own label layout uses)
    const top = (element.height - layout.lines.length * layout.lineHeight) / 2;
    layout.lines.forEach((line, index) => {
      const tspan = svg("tspan", { x: element.width / 2, y: top + (index + 0.75) * layout.lineHeight });
      tspan.textContent = line;
      label.appendChild(tspan);
    });
    parentGfx.appendChild(label);
    return rect;
  }

  override getShapePath(shape: { x: number; y: number; width: number; height: number }): string {
    const { x, y, width, height } = shape;
    return `M${x},${y}l${width},0l0,${height}l${-width},0z`;
  }
}
