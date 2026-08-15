/**
 * The collaborative editor — chosen per notation (@bpmiq/notations):
 *   bpmn        → bpmn-js canvas (primary) + Monaco XML toggle, both bound to the
 *                 same shared Y.Text
 *   dmn         → dmn-js (DRD + decision table + literal expression) with the
 *                 simulation add-on + the same Monaco XML toggle, same shared
 *                 Y.Text; the Checks panel analyses and simulates it in-browser
 *                 through @bpmiq/decisions (the module the Live Host uses too)
 *   everything  → Monaco text editor on the shared Y.Text, language from the
 *   else          registry (OWM/TT/VC live-edit as text)
 *
 * React owns the shell (toolbar, presence, release); the editor ENGINES stay
 * imperative — bpmn-js / dmn-js / Monaco / Yjs live in refs inside one effect
 * whose cleanup tears the whole live session down (provider, sockets, bindings).
 */
import { roomName } from "@bpmiq/contracts/live";
import { openLiveSession } from "@bpmiq/live-client";
import { bindBpmn } from "@bpmiq/live-client/bpmn-sync";
import { bindDmn } from "@bpmiq/live-client/dmn-sync";
import { updateText } from "@bpmiq/live-client/text";
import { byExtension } from "@bpmiq/notations";
import { Badge } from "@bpmiq/ui-kit/components/badge";
import { Button } from "@bpmiq/ui-kit/components/button";
import { cn } from "@bpmiq/ui-kit/lib/utils";
import DmnSimulationModule from "@emaarco/dmn-js-simulation";
import { useMutation } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import BpmnModeler from "bpmn-js/lib/Modeler";
import DmnModeler from "dmn-js/lib/Modeler";
import { ArrowLeft, History, ListTodo, Loader2, Plus, ShieldCheck } from "lucide-react";
import * as monaco from "monaco-editor";
import { lazy, Suspense, useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { MonacoBinding } from "y-monaco";
import type * as Y from "yjs";

import { HistoryDiffDialog } from "@/components/history-diff-dialog";
import { HistoryPanel } from "@/components/history-panel";
import { ReleaseDialog } from "@/components/release-dialog";
import { TodoCreateDialog } from "@/components/todo-create-dialog";
import { TodoPanel } from "@/components/todo-panel";
import {
  config,
  fetchFileAtCommit,
  type FileCommitWire,
  type Me,
  type TodoElementWire,
  type TodoWire,
} from "@/lib/api";
import { useFileHistory, useTodos } from "@/lib/queries";
import { attachTodoCanvas, type TodoCanvas } from "@/lib/todo-canvas";

interface Presence {
  name: string;
  color: string;
}

// The decision checks pull in the FEEL engine and the DMN parser
// (@bpmiq/decisions + @bpmiq/notations). Split them off: only a .dmn author who
// opens the panel pays for them, and a BPMN session never loads them at all.
const DecisionChecksPanel = lazy(() =>
  import("@/components/decision-checks-panel").then((m) => ({ default: m.DecisionChecksPanel })),
);

function monacoLanguage(docPath: string): string {
  const notation = byExtension(docPath);
  if (notation) return notation.monacoLanguage;
  if (docPath.endsWith(".yaml") || docPath.endsWith(".yml")) return "yaml";
  if (docPath.endsWith(".md")) return "markdown";
  return "plaintext";
}

export function LiveEditor({
  repo,
  processId,
  docPath,
  backDir,
  revealElementId,
  me,
}: {
  repo: string;
  processId: string;
  docPath: string;
  /** processes-root-relative folder the Back arrow returns to ("" = root) */
  backDir?: string;
  /** deep-link target (?element=<id>) — revealed ONCE after the first diagram import */
  revealElementId?: string;
  me: Me;
}) {
  const notation = byExtension(docPath);
  const isBpmn = notation?.id === "bpmn";
  const isDmn = notation?.id === "dmn";
  const isVisual = isBpmn || isDmn;
  const fileName = docPath.split("/").pop() ?? docPath;
  const [owner = "", name = ""] = repo.split("/");

  const canvasRef = useRef<HTMLDivElement>(null);
  const xmlRef = useRef<HTMLDivElement>(null);
  const [status, setStatus] = useState<"connecting" | "slow" | "live" | "error">("connecting");
  const [error, setError] = useState<string | null>(null);
  const [showXml, setShowXml] = useState(!isVisual);
  const [presence, setPresence] = useState<Presence[]>([]);

  // model-anchored todos — only for documents that belong to a process
  const hasTodos = processId.length > 0;
  const todosQuery = useTodos(repo, processId, hasTodos);
  const [selectedElements, setSelectedElements] = useState<TodoElementWire[]>([]);
  const [todoFilter, setTodoFilter] = useState<string | null>(null);
  const [todoCreateOpen, setTodoCreateOpen] = useState(false);
  // the canvas controller lives inside the imperative session effect; the query
  // data flows in through these refs (and the effect below) in either order
  const todoCanvasRef = useRef<TodoCanvas | null>(null);
  const todosRef = useRef<TodoWire[]>([]);

  // decision checks (.dmn only) — analysis + simulation, computed in-browser
  // from the live document by @bpmiq/decisions
  const [dmnXml, setDmnXml] = useState("");

  // the ONE open side panel — the panels are mutually exclusive, and the rule
  // lives here instead of being hand-written into every toggle (one of the
  // five copies had already gone stale)
  const [panel, setPanel] = useState<"todos" | "history" | "checks" | null>(null);
  const togglePanel = (name: "todos" | "history" | "checks"): void => {
    setTodoFilter(null);
    setPanel((current) => (current === name ? null : name));
  };
  const closePanel = (): void => {
    setTodoFilter(null);
    setPanel(null);
  };
  // default-branch commit history of THIS file — fetched while the panel is open
  const historyQuery = useFileHistory(repo, docPath, panel === "history");
  // the shared Y.Text, exposed from the session effect for Compare/Restore
  const contentRef = useRef<Y.Text | null>(null);
  const [diff, setDiff] = useState<{ commit: FileCommitWire; historical: string; current: string } | null>(null);

  const todoList = todosQuery.data;
  useEffect(() => {
    todosRef.current = todoList ?? [];
    todoCanvasRef.current?.setTodos(todosRef.current);
  }, [todoList]);

  // deep-link reveal: hand the ?element target to the canvas controller. Before
  // the controller exists (session still syncing) it is parked in the ref and
  // armed once in attach(); the controller's revealOnce consumes it after the
  // FIRST import.done, so remote re-imports / session re-attaches never re-zoom.
  const pendingRevealRef = useRef<string | null>(null);
  useEffect(() => {
    if (!revealElementId) return;
    const canvas = todoCanvasRef.current;
    if (canvas) canvas.revealOnce(revealElementId);
    else pendingRevealRef.current = revealElementId;
  }, [revealElementId]);

  useEffect(() => {
    let cancelled = false;
    const session = openLiveSession({
      url: config.wsUrl,
      // room name = <repo-full-name>/<repo-relative-path> (@bpmiq/contracts/live)
      room: roomName(repo, docPath),
      token: me.wsToken,
      onAuthenticationFailed: (reason) => {
        if (cancelled) return;
        setError(`Access denied: ${reason}`);
        setStatus("error");
      },
    });
    session.setUser({ name: me.user.name || me.user.login, color: config.color });

    let modeler: InstanceType<typeof BpmnModeler> | undefined;
    let dmnModeler: InstanceType<typeof DmnModeler> | undefined;
    let unbindCanvas: (() => void) | undefined;
    let todoCanvas: TodoCanvas | undefined;
    let monacoBinding: MonacoBinding | undefined;
    let xmlEditor: monaco.editor.IStandaloneCodeEditor | undefined;
    let xmlModel: monaco.editor.ITextModel | undefined;
    let offPresence: (() => void) | undefined;
    let attached = false;

    // Attach the editor ENGINES when the doc syncs — even if that takes longer
    // than the "slow" hint below (a Fly cell resuming from suspend + first clone
    // can exceed 10s). No hard timeout that abandons a late sync into a dead editor.
    const attach = () => {
      if (cancelled || attached) return;
      attached = true;
      const ytext = session.content;
      contentRef.current = ytext;
      if (isBpmn && canvasRef.current) {
        modeler = new BpmnModeler({ container: canvasRef.current });
        unbindCanvas = bindBpmn(modeler as never, ytext, session.doc, (msg) => toast.error(msg));
        if (hasTodos) {
          // badges re-attach on every import.done (bindBpmn re-imports remote
          // changes); a badge click opens the panel filtered to its element
          todoCanvas = attachTodoCanvas(modeler as never, {
            onBadgeClick: (elementId) => {
              setTodoFilter(elementId);
              setPanel("todos");
            },
            onSelectionChanged: setSelectedElements,
          });
          todoCanvasRef.current = todoCanvas;
          todoCanvas.setTodos(todosRef.current);
          if (pendingRevealRef.current) {
            // deep link opened before the session synced — arm the one-shot now
            todoCanvas.revealOnce(pendingRevealRef.current);
            pendingRevealRef.current = null;
          }
        }
      } else if (isDmn && canvasRef.current) {
        dmnModeler = new DmnModeler({
          container: canvasRef.current,
          // the SAME simulation add-on the MCP-App decision widget mounts:
          // enter values in a decision table and the matching rows light up.
          // It evaluates with `feelin`, as does @bpmiq/decisions in the Checks
          // panel and on the server — one semantics, three places.
          drd: { additionalModules: [DmnSimulationModule.decisionRequirementsDiagram] },
          decisionTable: { additionalModules: [DmnSimulationModule.decisionTable] },
        });
        unbindCanvas = bindDmn(
          dmnModeler as never,
          ytext,
          session.doc,
          (msg) => {
            if (!cancelled) toast.error(msg);
          },
          // malformed from the start: nothing to render — surface the error and
          // fall back to the XML view, where the document stays editable
          (msg) => {
            if (cancelled) return; // an in-flight first import can settle after unmount
            toast.error(`DMN import failed: ${msg}`);
            setShowXml(true);
          },
        );
      }
      if (xmlRef.current) {
        xmlModel = monaco.editor.createModel(ytext.toString(), monacoLanguage(docPath));
        xmlEditor = monaco.editor.create(xmlRef.current, {
          model: xmlModel,
          automaticLayout: true,
          minimap: { enabled: false },
          fontSize: 12,
        });
        monacoBinding = new MonacoBinding(ytext, xmlModel, new Set([xmlEditor]), session.awareness ?? undefined);
      }
      offPresence = session.onPresence(setPresence);
      setStatus("live");
    };
    const offSynced = session.onSynced(attach);
    // still connecting after 10s → tell the user it's taking a while, keep waiting
    const slow = setTimeout(() => {
      if (!cancelled && !attached) setStatus("slow");
    }, 10_000);

    return () => {
      cancelled = true;
      clearTimeout(slow);
      offSynced();
      offPresence?.();
      contentRef.current = null;
      todoCanvas?.destroy();
      todoCanvasRef.current = null;
      unbindCanvas?.();
      monacoBinding?.destroy();
      xmlEditor?.dispose();
      xmlModel?.dispose();
      modeler?.destroy();
      dmnModeler?.destroy();
      session.destroy(); // provider AND socket
    };
  }, [repo, docPath, me.wsToken]);

  // Feed the Checks panel from the shared Y.Text — only while it is OPEN, and
  // debounced: re-analysing on every keystroke of a co-editor would be pure
  // waste (`status` re-runs this once the session attached contentRef).
  useEffect(() => {
    const ytext = panel === "checks" && isDmn ? contentRef.current : null;
    if (!ytext) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const sync = () => setDmnXml(ytext.toString());
    sync();
    const onChange = () => {
      clearTimeout(timer);
      timer = setTimeout(sync, 300);
    };
    ytext.observe(onChange);
    return () => {
      clearTimeout(timer);
      ytext.unobserve(onChange);
    };
  }, [panel, isDmn, status]);

  // release = pick files in the ReleaseDialog, THIS document preselected
  const [releaseOpen, setReleaseOpen] = useState(false);

  // TanStack v5 runs hook-level onSuccess/onError even after unmount and for
  // superseded mutate() calls — guard both: only the LATEST action may apply,
  // and nothing toasts onto an unrelated screen after this editor is gone
  const actionSeqRef = useRef(0);
  const aliveRef = useRef(true);
  useEffect(() => {
    aliveRef.current = true;
    return () => {
      aliveRef.current = false;
    };
  }, []);
  const fetchCommitContent = async (commit: FileCommitWire) => {
    const seq = ++actionSeqRef.current;
    const file = await fetchFileAtCommit(repo, docPath, commit.sha);
    return { commit, historical: file.content, seq };
  };
  const onActionError = (e: Error) => {
    if (aliveRef.current) toast.error(e.message);
  };

  // Compare: fetch the commit's content, snapshot the live doc, open the diff
  const compare = useMutation({
    mutationFn: fetchCommitContent,
    onSuccess: ({ commit, historical, seq }) => {
      if (seq !== actionSeqRef.current || !aliveRef.current) return; // superseded or editor gone
      const current = contentRef.current?.toString();
      if (current === undefined) return; // session not attached — nothing to diff against
      setDiff({ commit, historical, current });
    },
    onError: onActionError,
  });

  // Restore: write the commit's content into the shared Y.Text — updateText's
  // minimal diff syncs to every client, the canvas binding re-imports the view
  const restore = useMutation({
    mutationFn: fetchCommitContent,
    onSuccess: ({ commit, historical, seq }) => {
      if (seq !== actionSeqRef.current || !aliveRef.current) return; // superseded or editor gone
      const ytext = contentRef.current;
      if (!ytext) {
        return void toast.error("Restore cancelled — the live session ended before the commit content arrived.");
      }
      updateText(ytext, historical);
      setDiff(null);
      toast.success(`Restored ${fileName} to ${commit.sha.slice(0, 7)}`, { description: commit.subject });
    },
    onError: onActionError,
  });
  const historyActionSha = compare.isPending
    ? (compare.variables?.sha ?? null)
    : restore.isPending
      ? (restore.variables?.sha ?? null)
      : null;

  const xmlActive = showXml || !isVisual;

  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center gap-2 border-b px-4 py-2">
        <Button asChild variant="ghost" size="icon" title="Back">
          <Link to="/r/$owner/$repo" params={{ owner, repo: name }} search={backDir ? { dir: backDir } : {}}>
            <ArrowLeft />
          </Link>
        </Button>
        <span className="truncate text-sm font-medium">
          {repo} · {processId || fileName}
          {!isBpmn && processId ? ` · ${fileName}` : ""}
        </span>
        {status === "live" && <Badge variant="success">live</Badge>}
        {(status === "connecting" || status === "slow") && (
          <Badge variant="secondary">
            <Loader2 className="animate-spin" /> {status === "slow" ? "connecting… (taking longer)" : "connecting…"}
          </Badge>
        )}
        {status === "error" && <Badge variant="destructive">offline</Badge>}
        {notation && !isBpmn && <Badge variant="outline">{notation.label}</Badge>}
        <div className="flex-1" />
        <div className="flex -space-x-1.5">
          {presence.map((u, i) => (
            <div
              key={i}
              className="border-background flex size-6 items-center justify-center rounded-full border-2 text-[10px] font-semibold text-white"
              style={{ background: u.color }}
              title={u.name}
            >
              {u.name.slice(0, 2).toUpperCase()}
            </div>
          ))}
        </div>
        {isVisual && (
          <Button variant="outline" size="sm" onClick={() => setShowXml((v) => !v)}>
            XML
          </Button>
        )}
        {isDmn && (
          <Button
            variant="outline"
            size="sm"
            title="Analyse this decision and try a scenario — runs in the browser"
            onClick={() => togglePanel("checks")}
          >
            <ShieldCheck />
            Checks
          </Button>
        )}
        <Button
          variant="outline"
          size="sm"
          title="History of this file on the default branch"
          onClick={() => togglePanel("history")}
        >
          <History />
          History
        </Button>
        {hasTodos && (
          <>
            <Button
              variant="outline"
              size="sm"
              title="Open todos for this process"
              onClick={() => togglePanel("todos")}
            >
              <ListTodo />
              Todos{todoList && todoList.length > 0 ? ` (${todoList.length})` : ""}
            </Button>
            <Button
              variant="outline"
              size="sm"
              title={
                selectedElements.length > 0
                  ? "Anchor a todo to the selection"
                  : "Create a process-level todo (no element selected)"
              }
              onClick={() => setTodoCreateOpen(true)}
            >
              <Plus />
              Todo{selectedElements.length > 0 ? ` · ${selectedElements.length}` : ""}
            </Button>
          </>
        )}
        <Button size="sm" onClick={() => setReleaseOpen(true)}>
          Release → PR
        </Button>
      </div>
      {error && <div className="bg-destructive/10 text-destructive border-b px-4 py-2 text-sm">{error}</div>}
      <div className="relative min-h-0 flex-1">
        <div
          ref={canvasRef}
          className={cn(
            isDmn ? "dmn-canvas" : "bpmn-canvas",
            "absolute inset-0",
            xmlActive && "pointer-events-none opacity-0",
          )}
        />
        <div
          ref={xmlRef}
          className={cn("monaco-host absolute inset-0", !xmlActive && "pointer-events-none opacity-0")}
        />
        {isDmn && panel === "checks" && (
          <Suspense fallback={null}>
            <DecisionChecksPanel repo={repo} xml={dmnXml} docPath={docPath} onClose={closePanel} />
          </Suspense>
        )}
        {panel === "history" && (
          <HistoryPanel
            commits={historyQuery.data}
            isLoading={historyQuery.isLoading}
            error={historyQuery.error}
            pendingSha={historyActionSha}
            actionsEnabled={status === "live"}
            onCompare={(c) => compare.mutate(c)}
            onRestore={(c) => restore.mutate(c)}
            onClose={closePanel}
          />
        )}
        {hasTodos && panel === "todos" && (
          <TodoPanel
            repo={repo}
            todos={todoList}
            isLoading={todosQuery.isLoading}
            error={todosQuery.error}
            filterElementId={todoFilter}
            onClearFilter={() => setTodoFilter(null)}
            onRevealElement={(elementId) => {
              if (!todoCanvasRef.current?.reveal(elementId))
                toast(`Element '${elementId}' no longer exists in the diagram.`);
            }}
            onClose={closePanel}
          />
        )}
      </div>
      {hasTodos && todoCreateOpen && (
        <TodoCreateDialog
          repo={repo}
          processId={processId}
          docPath={docPath}
          elements={selectedElements}
          onClose={() => setTodoCreateOpen(false)}
        />
      )}
      {diff && (
        <HistoryDiffDialog
          commit={diff.commit}
          historical={diff.historical}
          current={diff.current}
          language={monacoLanguage(docPath)}
          isBpmn={isBpmn}
          restorePending={restore.isPending}
          onRestore={() => restore.mutate(diff.commit)}
          onClose={() => setDiff(null)}
        />
      )}
      {releaseOpen && <ReleaseDialog repo={repo} preselect={[docPath]} onClose={() => setReleaseOpen(false)} />}
    </div>
  );
}
