/**
 * The sticky module (#117) — everything the bpmn-js Modeler needs to
 * speak sticky: pass `bpmnStickyModule` via `additionalModules` and
 * `stickyModdle` via `moddleExtensions`. Stickies persist as
 * `<bpmiq:sticky/>` extension elements (legacy-name-ok: frozen namespace)
 * with no BPMNDI, ride the existing Y.Text/bpmn-sync collab and are ignored
 * by the derive/validator toolchain (warn-only residue check aside). It also
 * carries the rest of the t.BPM workshop tooling: the reduced palette (#54)
 * and group naming (#190).
 */
import "./sticky.css";

import { GroupNaming } from "./group-naming";
import { StickyCopyPaste } from "./sticky-copy-paste";
import { StickyElementFactory } from "./sticky-factory";
import { stickyModdle } from "./sticky-moddle";
import { StickyOrdering } from "./sticky-ordering";
import { StickyPersistence } from "./sticky-persistence";
import { StickyRenderer } from "./sticky-renderer";
import { StickyResizePreview } from "./sticky-resize";
import { StickyRules } from "./sticky-rules";
import { StickyContextPad, StickyEditing, StickyPalette } from "./sticky-ui";

export const bpmnStickyModule = {
  __init__: [
    "stickyRenderer",
    "stickyRules",
    "stickyOrdering",
    "stickyPalette",
    "stickyContextPad",
    "stickyEditing",
    "stickyPersistence",
    "stickyCopyPaste",
    "stickyResizePreview",
    "groupNaming",
  ],
  elementFactory: ["type", StickyElementFactory],
  stickyRenderer: ["type", StickyRenderer],
  stickyRules: ["type", StickyRules],
  stickyOrdering: ["type", StickyOrdering],
  stickyPalette: ["type", StickyPalette],
  stickyContextPad: ["type", StickyContextPad],
  stickyEditing: ["type", StickyEditing],
  stickyPersistence: ["type", StickyPersistence],
  stickyCopyPaste: ["type", StickyCopyPaste],
  stickyResizePreview: ["type", StickyResizePreview],
  groupNaming: ["type", GroupNaming],
};

export { stickyModdle };
export { bpmnStickyViewModule } from "./sticky-view";
export { tbpmToggleAction } from "./tbpm-action";
