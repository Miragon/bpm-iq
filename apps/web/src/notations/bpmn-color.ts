/**
 * Element colours (#189) — bpmn-io's color picker, the one Camunda Modeler and
 * the Miragon BPMN modeller ship: a brush in the context pad (single elements
 * and multi-selections) opens six FIXED swatches, Default resets. Fixed on
 * purpose: a colour carries meaning in a workshop (red = open issue, green =
 * agreed), a free picker would dilute it.
 *
 * The palette is the package default, deliberately: the stroke doubles as the
 * label colour in bpmn-js, and these pairs keep labels ≥ 7:1 on their fill
 * (the Miragon functional colours reach 3.4–4.8:1 on a visible tint), and the
 * values match what those other modellers write — a diagram recoloured there
 * does not churn the PR diff.
 *
 * Storage is modeling.setColor: BPMN in Color (`color:background-color` /
 * `color:border-color`) plus `bioc:fill` / `bioc:stroke` on the BPMNDI shape
 * or edge — one command, so undo/redo and the live sync come for free.
 * Stickies have their own kinds and no DI; their pad never offers the brush
 * (StickyContextPad).
 */
import "bpmn-js-color-picker/colors/color-picker.css";

import colorPickerModule from "bpmn-js-color-picker";

export const bpmnColorModule = colorPickerModule;
