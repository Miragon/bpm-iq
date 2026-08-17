/**
 * The Miragon comet — the one geometry, shared by the React SPA header
 * (components/miragon-comet.tsx) and the vanilla-TS widget toolbars
 * (mcp-app/shell.ts). The contour is fitted from the brand asset; the colour
 * is hard-wired because a brand colour does not follow the theme.
 *
 * The favicon (public/favicon.svg) carries the same path rotated onto the
 * diagonal — a standalone file cannot import, so keep the two in sync.
 */
export const COMET_VIEW_BOX = "0 0 112 34.9";
export const COMET_ASPECT = 112 / 34.9;
export const COMET_COLOR = "#00E676";
export const COMET_PATH =
  "M0 34.83C1.15 34.59 2.22 34.08 3.31 33.66C5.14 32.95 6.95 32.21 8.77 31.51C14.6 29.24 20.41 26.95 26.22 24.65C37.63 20.14 49.07 15.68 60.52 11.26C67.92 8.42 75.26 5.39 82.74 2.77C84.43 2.19 86.17 1.74 87.91 1.34C94.39-0.13 102.84-1.5 108.06 3.67C108.9 4.5 109.62 5.44 110.22 6.47C110.92 7.68 111.42 8.99 111.71 10.36C112.01 11.79 112.08 13.27 111.9 14.72C111.51 17.99 109.9 21.04 107.41 23.19C106.89 23.65 106.32 24.07 105.73 24.44C105.55 24.55 105.21 24.84 105 24.86C103.44 25 101.52 26.3 99.8 26.84C96.63 27.82 93.25 28.35 89.96 28.74C84.65 29.37 79.29 29.58 73.97 29.93C63.67 30.61 53.37 31.21 43.08 32C33.98 32.69 24.88 33.22 15.79 33.83C10.55 34.19 5.25 34.79 0 34.85Z";

/** the comet as a DOM node, for the widget bundles (no React in there) */
export function cometElement(heightPx: number): SVGSVGElement {
  const ns = "http://www.w3.org/2000/svg";
  const svg = document.createElementNS(ns, "svg");
  svg.setAttribute("viewBox", COMET_VIEW_BOX);
  svg.setAttribute("height", String(heightPx));
  svg.setAttribute("width", (heightPx * COMET_ASPECT).toFixed(1));
  svg.setAttribute("fill", COMET_COLOR);
  svg.setAttribute("aria-hidden", "true");
  const path = document.createElementNS(ns, "path");
  path.setAttribute("d", COMET_PATH);
  svg.append(path);
  return svg;
}
