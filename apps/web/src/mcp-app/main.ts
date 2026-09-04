/**
 * The BPMN modeler widget — the bpmn engine on the shared widget core
 * (core/widget.ts + core/lifecycle.ts: App handshake → tool input → load the
 * live document → engine → CAS autosave with the conflict banner → live
 * upgrade). What is BPMN here: the sticky/t.BPM modules inside the engine,
 * the todo panel + badges, the process deep link carrying the canvas
 * selection, and the inlined bpmn icon font.
 */
import "./styles.css";

import { processDeepLink } from "@bpmiq/contracts/deep-link";
import { modelStem } from "@bpmiq/notations";

import { tbpmToggleAction } from "@/notations/bpmn-sticky";

import { bootWidget } from "./core/widget";
import { type BpmnEngine, mountBpmnEngine } from "./engines/bpmn";
import { mountTodos } from "./todos";

bootWidget<BpmnEngine>({
  notation: "bpmn",
  noun: "model",
  engine: mountBpmnEngine,
  iconFont: "bpmn",
  // the process route, carrying the canvas selection (?element=)
  deepLink: (publicUrl, doc, engine) =>
    processDeepLink(publicUrl, doc.repo, modelStem(doc.path), engine.selectedElementId?.()),
  extras: ({ app, engine, readonly, chrome }) => {
    // t.BPM switch (#117): same document-property flip as the web editor's
    // header toggle — a facilitator can start a workshop from the widget
    if (engine.editable) mountTbpmSwitch(chrome.saveBtn, engine);
    // bound BEFORE the first import: the canvas controller re-renders its
    // badges on every `import.done` (incl. the live re-imports)
    const todos = mountTodos(app, engine, { readonly });
    return { onDocument: (doc) => todos.load(doc), destroy: () => todos.destroy() };
  },
});

/** the widget-chrome twin of the web editor's t.BPM header switch */
function mountTbpmSwitch(anchor: HTMLElement, engine: BpmnEngine): void {
  const action = tbpmToggleAction(engine.raw as never);
  const label = document.createElement("label");
  label.id = "tbpm";
  label.title = action.buttonTitle;
  const text = document.createElement("span");
  text.textContent = action.label;
  const sw = document.createElement("button");
  sw.type = "button";
  sw.setAttribute("role", "switch");
  sw.append(document.createElement("span"));
  const sync = (): void => sw.setAttribute("aria-checked", String(action.isActive?.() ?? false));
  sw.onclick = () => action.run();
  action.onChanged?.(sync);
  sync();
  label.append(text, sw);
  anchor.before(label);
}
