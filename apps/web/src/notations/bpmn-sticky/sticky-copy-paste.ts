/**
 * Sticky copy & paste (#187): Cmd/Ctrl+C, V, X and D work on stickies — the
 * copy keeps size, text and kind, the paste mints a NEW sticky id, so the
 * .bpmn never holds two <bpmiq:sticky/> with the same id.
 *
 * bpmn-js' BpmnCopyPaste copies every element as businessObject + DI; a
 * sticky has no DI (its coordinates live on the extension element), so those
 * handlers would throw on one. The sticky handlers slot in around them:
 *
 *  - copyElement at 900: AFTER diagram-js' descriptor basics (1000: id,
 *    x/y/width/height), BEFORE BpmnCopyPaste's DI copy (750) — which the
 *    returned descriptor stops
 *  - pasteElement at 1500: BEFORE BpmnCopyPaste (1000) — a fresh
 *    bpmiq:Sticky businessObject WITHOUT an id, so StickyElementFactory mints
 *    one; the pasted shape then persists through the ordinary shape.create
 *    path (StickyPersistence), exactly like a sticky from the palette
 */
import { isSticky, type ModdleLike, STICKY_TYPE, stickyKindOf } from "./sticky-model";

const COPY_PRIORITY = 900;
const PASTE_PRIORITY = 1500;

/** the slice of a copy-paste descriptor a sticky uses */
interface StickyDescriptor {
  type?: string;
  businessObject?: ModdleLike;
  /** plain values, never the moddle element: the clipboard outlives edits
   *  and re-imports of the source sticky */
  sticky?: { text: string; kind: string };
}

interface EventBusLike {
  on<E>(event: string, priority: number, cb: (event: E) => unknown): void;
}
interface BpmnFactoryLike {
  create(type: string, attrs?: Record<string, unknown>): ModdleLike;
}

/** businessObjects minted by a paste — the creation rules let these in
 *  outside workshop mode too: copying is not a new creation path */
const pasted = new WeakSet<object>();

export function isPastedSticky(element: unknown): boolean {
  const bo = (element as { businessObject?: object } | null)?.businessObject;
  return !!bo && pasted.has(bo);
}

export class StickyCopyPaste {
  static $inject = ["eventBus", "bpmnFactory"];

  constructor(eventBus: EventBusLike, bpmnFactory: BpmnFactoryLike) {
    eventBus.on<{ descriptor: StickyDescriptor; element: unknown }>(
      "copyPaste.copyElement",
      COPY_PRIORITY,
      ({ descriptor, element }) => {
        if (!isSticky(element)) return undefined;
        const bo = element.businessObject;
        descriptor.type = STICKY_TYPE;
        descriptor.sticky = { text: bo.text ?? "", kind: stickyKindOf(bo) };
        return descriptor;
      },
    );

    eventBus.on<{ descriptor: StickyDescriptor }>("copyPaste.pasteElement", PASTE_PRIORITY, ({ descriptor }) => {
      if (descriptor.type !== STICKY_TYPE || !descriptor.sticky) return undefined;
      const bo = bpmnFactory.create(STICKY_TYPE, { ...descriptor.sticky });
      pasted.add(bo);
      descriptor.businessObject = bo;
      delete descriptor.sticky;
      return true;
    });
  }
}
