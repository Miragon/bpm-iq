/**
 * The widget's MCP side: the ext-apps App handshake and typed wrappers around
 * the Live-Host tools it calls through the host bridge. App-initiated
 * tools/call rides the host's authenticated connection to POST /mcp — the same
 * per-call authorization as agent calls, no credential in the iframe.
 *
 * Tool results arrive as JSON in the first text content block (the `ok()`
 * helper in apps/live-host/src/http/mcp.ts) — parsed here, typed via the
 * shared wire contracts so server drift breaks the build, not the widget.
 *
 * The canvas widgets (bpmn, wardley, team topology, event storming) read and
 * save through the notation-generic get_model_content / save_model_content;
 * the decision widget keeps the dmn pair. Not every tool exists on every
 * host: the todo tools are absent without a configured tracker (and the write
 * ones in read-only mode), exactly like mint_ws_ticket. There is no tools/list over the app bridge, so absence is
 * detected on the first call — `isMissingTool` separates "capability absent"
 * (hide the UI) from a real tracker error (show it; those messages are
 * actionable).
 */
import type {
  ContentWire,
  PutContentResultWire,
  TodoElementWire,
  TodoWire,
  WidgetBootWire,
} from "@bpmiq/contracts/live-host";
import type { CaseOutcome, SuiteOutcome, TestCase, TestSuite } from "@bpmiq/decisions/tests";
import { unwrapToolResult } from "@bpmiq/mcp-kit";
import { App } from "@modelcontextprotocol/ext-apps";

export type BootConfig = WidgetBootWire;

export interface ProcessRef {
  repo: string;
  id?: string;
  path?: string;
}

/** a model of ANY notation (the generic tools' ref): `notation` pins the
 *  registry id so an `id` shared across notations resolves within the widget's
 *  own — a widget never opens another notation's twin */
export interface ModelRef extends ProcessRef {
  notation?: string;
}

/** the save tools' conflict shape (mcp.ts wraps the use-case result — the
 *  conflict is a retryable RESULT, not an error) */
export interface SaveConflict {
  ok: false;
  conflict: true;
  path: string;
  /** re-derive the edit against this and retry with the fresh baseVersion */
  currentContent: string;
  baseVersion: string;
  message: string;
}

export type SaveResult = ({ ok: true } & PutContentResultWire) | SaveConflict;
// PutContentResultWire.errors carries ERROR findings on lint:"warn" saves

/** the host-injected marker (mcp.ts replaces it); a raw marker means the file
 *  is served outside the Live Host (dev preview) — default to editable, with
 *  this very origin as the deep-link base (the dev server serves the SPA too).
 *  A parsed payload WITHOUT publicUrl (older Live Host) keeps it absent — the
 *  "Open in bpmiq" button hides rather than dead-link. */
export function bootConfig(): BootConfig {
  const raw = (window as { BPMIQ_BOOT?: unknown }).BPMIQ_BOOT;
  if (typeof raw === "string" && !raw.startsWith("__")) {
    try {
      return JSON.parse(raw) as BootConfig;
    } catch {
      /* fall through to the default */
    }
  }
  return { readonly: false, publicUrl: window.location.origin };
}

export function makeApp(): App {
  return new App({ name: "bpmiq-modeler", version: "1.0.0" });
}

/** one tool call → parsed JSON payload; tool `isError` becomes a throw with
 *  the server's agent-readable message (the widget shows it verbatim) —
 *  decoding is the shared @bpmiq/mcp-kit codec, the inverse of the server's ok() */
async function call<T>(app: App, name: string, args: Record<string, unknown>): Promise<T> {
  return unwrapToolResult<T>(await app.callServerTool({ name, arguments: args }), name);
}

// ── the canvas widgets (core/widget.ts): the notation-generic tools ─────────

/** the live text + baseVersion of a model of ANY notation */
export const getModelContent = (app: App, ref: ModelRef): Promise<ContentWire> =>
  call(app, "get_model_content", { ...ref });

/** lint:"warn" — the widget autosaves like the live rooms do: findings inform,
 *  never block; the strict default stays for agent saves */
export const saveModelContent = (
  app: App,
  ref: { repo: string; path: string },
  content: string,
  baseVersion: string,
): Promise<SaveResult> =>
  call(app, "save_model_content", { repo: ref.repo, path: ref.path, content, baseVersion, lint: "warn" });

// ── DMN decisions (the decision widget) ─────────────────────────────────────
// The wire shapes below are the LIB's own types (@bpmiq/decisions, isomorphic —
// the widget runs the very same module the Live Host answers with), so a server
// change breaks the build here instead of drifting silently. Only the tool
// envelope (`exists`, `path`) is local: it belongs to mcp.ts, not to the suite.

export const getDmnXml = (app: App, ref: ProcessRef): Promise<ContentWire> => call(app, "get_dmn_xml", { ...ref });

/** lint:"warn" — same autosave trust level as the BPMN widget */
export const saveDmnXml = (app: App, ref: ProcessRef, xml: string, baseVersion: string): Promise<SaveResult> =>
  call(app, "save_dmn_xml", { repo: ref.repo, path: ref.path, xml, baseVersion, lint: "warn" });

/** one case of `<decision>.tests.yaml` */
export type DecisionTestCase = TestCase;
export type CaseOutcomeWire = CaseOutcome;
export type SuiteRunWire = SuiteOutcome;

export interface StoredTestsWire {
  exists: boolean;
  path: string;
  baseVersion?: string;
  suite?: TestSuite;
}

export const runDecisionTests = (app: App, ref: ProcessRef): Promise<SuiteRunWire> =>
  call(app, "run_decision_tests", { repo: ref.repo, path: ref.path });

export const getDecisionTests = (app: App, ref: ProcessRef): Promise<StoredTestsWire> =>
  call(app, "get_decision_tests", { repo: ref.repo, path: ref.path });

/** write the suite; `record` freezes the current behaviour of cases without an
 *  expectation — how "capture this scenario as a test" is implemented */
export const saveDecisionTests = (
  app: App,
  ref: ProcessRef,
  cases: DecisionTestCase[],
  opts: { baseVersion?: string; record?: boolean } = {},
): Promise<{ ok?: boolean; conflict?: true; path: string; baseVersion: string }> =>
  call(app, "save_decision_tests", { repo: ref.repo, path: ref.path, cases, ...opts });

export interface WsTicket {
  ticket: string;
  url: string;
  room: string;
  expiresInSeconds: number;
}

/** single-use ticket for the live Yjs connection — write-gated at mint time */
export const mintWsTicket = (app: App, ref: ProcessRef): Promise<WsTicket> =>
  call(app, "mint_ws_ticket", { repo: ref.repo, path: ref.path });

// ── todos (model-anchored work items in the repo's own tracker) ──────────────

/** the SDK answers an unregistered tool with "Tool <name> not found" — that is
 *  a MISSING CAPABILITY (no tracker configured, or the read-only surface), not
 *  a failure to report. The predicate is the shared @bpmiq/mcp-kit one. */
export { isMissingTool } from "@bpmiq/mcp-kit";

/** OPEN todos of ONE process (the widget always scopes to the open document) */
export const listTodos = (app: App, ref: ProcessRef): Promise<{ todos: TodoWire[] }> =>
  call(app, "list_todos", { repo: ref.repo, path: ref.path });

export interface CreateTodoInput {
  title: string;
  body?: string;
  /** canvas selection at submit time — empty ⇒ a process-level todo */
  elements: TodoElementWire[];
}

export const createTodo = (app: App, ref: ProcessRef, input: CreateTodoInput): Promise<{ todo: TodoWire }> =>
  call(app, "create_todo", { repo: ref.repo, path: ref.path, ...input });

export const closeTodo = (app: App, repo: string, todoId: string): Promise<{ ok: true }> =>
  call(app, "close_todo", { repo, todoId });

/** newest widget instance wins: every boot broadcasts; older instances for the
 *  same doc disable themselves (all app iframes of a connector share an origin).
 *  Returns the release — a re-claiming widget MUST release its previous claim
 *  first, or its own broadcast supersedes itself. */
export function claimDocument(key: string, onSuperseded: () => void): () => void {
  const channel = new BroadcastChannel(`bpmiq-modeler:${key}`);
  const stamp = Date.now() + Math.random();
  channel.postMessage(stamp);
  channel.onmessage = (e: MessageEvent<number>) => {
    if (e.data !== stamp) onSuperseded();
  };
  return () => channel.close();
}
