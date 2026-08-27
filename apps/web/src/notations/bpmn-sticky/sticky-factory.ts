/**
 * Sticky element factory (#117) — overrides bpmn-js' ElementFactory for the
 * ONE case it must not handle: bpmiq:Sticky shapes get NO DI (their
 * coordinates live on the extension element; bpmn-js' createElement would
 * mint a dangling bpmndi:BPMNShape for them). Everything else falls through
 * to the bpmn implementation untouched.
 */
import ElementFactory from "bpmn-js/lib/features/modeling/ElementFactory";

import { STICKY_SIZE, STICKY_TYPE } from "./sticky-model";

const nextStickyId = (): string => `Sticky_${crypto.randomUUID().replace(/-/g, "").slice(0, 8)}`;

interface StickyAttrs {
  type?: string;
  businessObject?: { $type?: string; id?: string };
}

export class StickyElementFactory extends ElementFactory {
  // inherited statics resolve through the class chain, but the DI container
  // reads $inject off THIS constructor — restate it explicitly
  static override $inject = ["bpmnFactory", "moddle", "translate"];

  override create(elementType: string, attrs?: StickyAttrs): never {
    const isStickyAttrs = attrs?.type === STICKY_TYPE || attrs?.businessObject?.$type === STICKY_TYPE;
    if (elementType === "shape" && isStickyAttrs && attrs) {
      const self = this as unknown as {
        _bpmnFactory: { create(type: string, attrs: Record<string, unknown>): { id?: string } };
        _baseCreate(elementType: string, attrs: Record<string, unknown>): never;
      };
      const businessObject = attrs.businessObject ?? self._bpmnFactory.create(STICKY_TYPE, { kind: "note", text: "" });
      // bpmnFactory only auto-ids BPMN types — stickies bring their own
      if (!businessObject.id) businessObject.id = nextStickyId();
      // element id = sticky id (bpmn-js pins ids the same way): stable across
      // peers and re-imports — presence selections and the rebuild dedupe
      // guard key on it; the diagram-js uid fallback would be session-local
      return self._baseCreate("shape", {
        ...STICKY_SIZE,
        ...attrs,
        id: businessObject.id,
        type: STICKY_TYPE,
        businessObject,
        // order level 11 (> bpmn's max 10): BpmnOrderingProvider reads
        // element.order first, so ITS index math (incl. the remove-before-
        // reinsert compensation) slots every BPMN element below stickies
        order: { level: 11 },
      });
    }
    return super.create(elementType as never, attrs as never) as never;
  }
}
