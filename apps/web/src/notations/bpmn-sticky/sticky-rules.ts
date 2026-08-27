/**
 * Sticky rules (#117) — registered ABOVE BpmnRules so sticky verdicts are
 * decided here and never reach the BPMN rule set (which knows nothing about
 * them). The semantics of the ticket:
 *
 *  - stickies FLOAT above the diagram: any drop target is fine (the
 *    ordering provider re-homes them to the canvas root), only drilldown
 *    planes refuse — and creation exists only in t.BPM workshop mode
 *  - resizable (min 60x60); never connect, never copy (a pasted sticky
 *    would duplicate its extension-element id)
 *  - mixed selections delegate the non-sticky subset back to the rule chain,
 *    so a lasso of tasks + stickies moves iff both parts may
 */
import { is } from "bpmn-js/lib/util/ModelUtil";
import RuleProvider from "diagram-js/lib/features/rules/RuleProvider";

import { isSticky, STICKY_MIN } from "./sticky-model";

const HIGH_PRIORITY = 1500;

interface TargetLike {
  collapsed?: boolean;
  parent?: unknown;
}

type Verdict = boolean | undefined;

/** where a sticky may land: ANYWHERE on the main plane — stickies float
 *  ABOVE the diagram (StickyOrdering re-homes them to the canvas root, so
 *  the hover target never becomes their parent and containers never grow) */
function canDropSticky(target: unknown): Verdict {
  if (!target) return true; // move start / no drop target yet — keep dragging
  const t = target as TargetLike;
  // a DRILLDOWN plane root (SubProcess root without a parent) is v1-excluded:
  // sticky coordinates are main-plane absolute and would migrate on reload
  if (is(target as never, "bpmn:SubProcess") && !t.parent) return false;
  return true;
}

export class StickyRules extends RuleProvider {
  static override $inject = ["eventBus", "injector"];

  private readonly _injector: { get(name: string): unknown };

  constructor(eventBus: never, injector: { get(name: string): unknown }) {
    super(eventBus); // NB super() runs init() — the rules only REGISTER there,
    this._injector = injector; // evaluation happens later, after this line
  }

  override init(): void {
    // sticky CREATION requires (a) a bpmn:Process to persist into and (b)
    // the t.BPM workshop mode — the rule is the last line of defense: the
    // palette/dblclick gates go stale when the mode toggle is UNDONE
    const canCreateSticky = (): boolean => {
      const bpmnjs = this._injector.get("bpmnjs") as {
        getDefinitions(): { mode?: unknown; rootElements?: Array<{ $type: string }> } | undefined;
      };
      const definitions = bpmnjs.getDefinitions();
      if (definitions?.mode !== "workshop") return false;
      return (definitions?.rootElements ?? []).some((r) => r.$type === "bpmn:Process");
    };

    const delegate = (context: Record<string, unknown>, shapes: unknown[]): Verdict => {
      const rules = this._injector.get("rules") as {
        allowed(action: string, context: Record<string, unknown>): Verdict;
      };
      return rules.allowed("elements.move", { ...context, shapes });
    };

    this.addRule("elements.move", HIGH_PRIORITY, (context: Record<string, unknown>) => {
      const shapes = (context.shapes as unknown[] | undefined) ?? [];
      const stickies = shapes.filter(isSticky);
      if (stickies.length === 0) return undefined; // not our business
      const verdict = canDropSticky(context.target);
      if (stickies.length === shapes.length) return verdict;
      // mixed selection: the rest must be movable too
      if (verdict !== true) return false;
      return delegate(
        context,
        shapes.filter((s) => !isSticky(s)),
      );
    });

    this.addRule(["shape.create", "elements.create"], HIGH_PRIORITY, (context: Record<string, unknown>) => {
      const elements = (context.elements as unknown[] | undefined) ?? [context.shape];
      const stickies = elements.filter(isSticky);
      if (stickies.length === 0) return undefined;
      if (stickies.length !== elements.length) return false; // never mixed-create
      if (!canCreateSticky()) return false;
      return canDropSticky(context.target);
    });

    this.addRule("shape.resize", HIGH_PRIORITY, (context: Record<string, unknown>) => {
      if (!isSticky(context.shape)) return undefined;
      const bounds = context.newBounds as { width?: number; height?: number } | undefined;
      if (bounds && ((bounds.width ?? 0) < STICKY_MIN.width || (bounds.height ?? 0) < STICKY_MIN.height)) return false;
      return true;
    });

    this.addRule("element.copy", HIGH_PRIORITY, (context: Record<string, unknown>) => {
      if (isSticky(context.element)) return false;
      return undefined;
    });

    this.addRule(["connection.create", "connection.reconnect"], HIGH_PRIORITY, (context: Record<string, unknown>) => {
      if (isSticky(context.source) || isSticky(context.target)) return false;
      return undefined;
    });
  }
}
