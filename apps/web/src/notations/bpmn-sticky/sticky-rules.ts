/**
 * Sticky rules (#117) — registered ABOVE BpmnRules so sticky verdicts are
 * decided here and never reach the BPMN rule set (which knows nothing about
 * them). The semantics of the ticket:
 *
 *  - free placement into any container (root, participant, lane, expanded
 *    sub-process) — no grid, no alignment
 *  - dropping ON a flow node ATTACHES the sticky (annotation use); the host
 *    then carries it along (diagram-js attach support)
 *  - stickies never connect, never resize, never copy (a pasted sticky would
 *    duplicate its extension-element id)
 *  - mixed selections delegate the non-sticky subset back to the rule chain,
 *    so a lasso of tasks + stickies moves iff both parts may
 */
import { is } from "bpmn-js/lib/util/ModelUtil";
import RuleProvider from "diagram-js/lib/features/rules/RuleProvider";

import { isSticky } from "./sticky-model";

const HIGH_PRIORITY = 1500;

interface TargetLike {
  collapsed?: boolean;
  parent?: unknown;
}

type Verdict = boolean | "attach" | undefined;

/** where a sticky may land */
function canDropSticky(target: unknown): Verdict {
  if (!target) return true; // move start / no drop target yet — keep dragging
  const t = target as TargetLike;
  if (is(target as never, "bpmn:Participant") || is(target as never, "bpmn:Lane")) return true;
  if (is(target as never, "bpmn:SubProcess")) {
    // an INLINE expanded sub-process (has a parent shape) is a container; a
    // DRILLDOWN plane root (no parent) is not — stickies persist absolute
    // main-plane coordinates and would migrate planes on reload (v1 limit)
    if (t.collapsed !== true && t.parent) return true;
    if (!t.parent) return false;
  }
  // the canvas root of a plain process or a collaboration
  if (is(target as never, "bpmn:Process") || is(target as never, "bpmn:Collaboration")) return true;
  // a flow node is an annotation HOST, not a container
  if (is(target as never, "bpmn:FlowNode")) return "attach";
  return false;
}

export class StickyRules extends RuleProvider {
  static override $inject = ["eventBus", "injector"];

  private readonly _injector: { get(name: string): unknown };

  constructor(eventBus: never, injector: { get(name: string): unknown }) {
    super(eventBus); // NB super() runs init() — the rules only REGISTER there,
    this._injector = injector; // evaluation happens later, after this line
  }

  override init(): void {
    // a document without any bpmn:Process cannot PERSIST a sticky — refuse
    // creation up front instead of drawing a shape that vanishes on reload
    const hasProcess = (): boolean => {
      const bpmnjs = this._injector.get("bpmnjs") as {
        getDefinitions(): { rootElements?: Array<{ $type: string }> } | undefined;
      };
      return (bpmnjs.getDefinitions()?.rootElements ?? []).some((r) => r.$type === "bpmn:Process");
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
      if (stickies.length === shapes.length) {
        // attaching is a single-shape gesture — a group never attaches
        return verdict === "attach" ? (shapes.length === 1 ? "attach" : false) : verdict;
      }
      // mixed selection: the rest must be movable AND the target must be a
      // sticky container (attach makes no sense for a group)
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
      if (!hasProcess()) return false;
      const verdict = canDropSticky(context.target);
      return verdict === "attach" ? (elements.length === 1 ? "attach" : false) : verdict;
    });

    this.addRule("shape.attach", HIGH_PRIORITY, (context: Record<string, unknown>) => {
      const shape = context.shape;
      if (!isSticky(shape)) return undefined;
      return canDropSticky(context.target) === "attach";
    });

    this.addRule("shape.resize", HIGH_PRIORITY, (context: Record<string, unknown>) => {
      if (isSticky(context.shape)) return false;
      return undefined;
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
