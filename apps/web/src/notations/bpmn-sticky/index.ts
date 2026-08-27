/**
 * The bpmiq sticky module (#117) — everything the bpmn-js Modeler needs to
 * speak sticky: pass `bpmnStickyModule` via `additionalModules` and
 * `bpmiqModdle` via `moddleExtensions`. Stickies persist as
 * `<bpmiq:sticky/>` extension elements (no BPMNDI), ride the existing
 * Y.Text/bpmn-sync collab and are ignored by the derive/validator toolchain
 * (warn-only residue check aside).
 */
import { bpmiqModdle } from "./bpmiq-moddle";
import { StickyElementFactory } from "./sticky-factory";
import { StickyOrdering } from "./sticky-ordering";
import { StickyPersistence } from "./sticky-persistence";
import { StickyRenderer } from "./sticky-renderer";
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
  ],
  elementFactory: ["type", StickyElementFactory],
  stickyRenderer: ["type", StickyRenderer],
  stickyRules: ["type", StickyRules],
  stickyOrdering: ["type", StickyOrdering],
  stickyPalette: ["type", StickyPalette],
  stickyContextPad: ["type", StickyContextPad],
  stickyEditing: ["type", StickyEditing],
  stickyPersistence: ["type", StickyPersistence],
};

export { bpmiqModdle };
export { tbpmToggleAction } from "./tbpm-action";
