/**
 * Group naming (#190): a freshly drawn bpmn:Group opens its label editor
 * right away, the way a new task does. bpmn-js' LabelEditingProvider only
 * auto-activates for activities, events, annotations and pools, so a group
 * would stay nameless until someone double-clicks its border. In the
 * workshop, the group IS the story-map activity ("Submit application") —
 * naming it is the very next step. The label is the group's categoryValue
 * (bpmn-js' GroupBehavior mints the bpmn:Category on create).
 */
import { is } from "bpmn-js/lib/util/ModelUtil";

/** the slot LabelEditingProvider uses: below Create's own create.end
 *  handler, so the shape is already on the canvas */
const PRIORITY = 500;

interface CreateEndEvent {
  isTouch?: boolean;
  context?: {
    shape?: unknown;
    canExecute?: unknown;
    hints?: { createElementsBehavior?: boolean };
  };
}

export class GroupNaming {
  static $inject = ["eventBus", "directEditing"];

  constructor(
    eventBus: { on(event: string, priority: number, cb: (event: CreateEndEvent) => void): void },
    directEditing: { activate(element: unknown): unknown },
  ) {
    eventBus.on("create.end", PRIORITY, (event) => {
      const context = event.context;
      // the same guards as LabelEditingProvider's own create.end hook
      if (event.isTouch || !context?.canExecute) return;
      if (context.hints?.createElementsBehavior === false) return;
      if (!is(context.shape as never, "bpmn:Group")) return;
      directEditing.activate(context.shape);
    });
  }
}
