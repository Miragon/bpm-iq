/**
 * The collaborative editor — chosen per notation (@bpmiq/notations):
 *   bpmn        → bpmn-js canvas (primary) + Monaco XML toggle, both bound to the
 *                 same shared Y.Text
 *   everything  → Monaco text editor on the shared Y.Text, language from the
 *   else          registry (DMN/OWM/TT/VC live-edit as text)
 *
 * React owns the shell (toolbar, presence, release); the editor ENGINES stay
 * imperative — bpmn-js / Monaco / Yjs live in refs inside one effect whose
 * cleanup tears the whole live session down (provider, sockets, bindings).
 */
import { roomName } from "@bpmiq/contracts/live";
import { openLiveSession } from "@bpmiq/live-client";
import { bindBpmn } from "@bpmiq/live-client/bpmn-sync";
import { byExtension } from "@bpmiq/notations";
import { Badge } from "@bpmiq/ui-kit/components/badge";
import { Button } from "@bpmiq/ui-kit/components/button";
import { cn } from "@bpmiq/ui-kit/lib/utils";
import { useMutation } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import BpmnModeler from "bpmn-js/lib/Modeler";
import { ArrowLeft, ListTodo, Loader2, Plus } from "lucide-react";
import * as monaco from "monaco-editor";
import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { MonacoBinding } from "y-monaco";

import { TodoCreateDialog } from "@/components/todo-create-dialog";
import { TodoPanel } from "@/components/todo-panel";
import { config, type Me, releaseProcess, type TodoElementWire, type TodoWire } from "@/lib/api";
import { useTodos } from "@/lib/queries";
import { attachTodoCanvas, type TodoCanvas } from "@/lib/todo-canvas";

interface Presence {
  name: string;
  color: string;
}

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
  processVersion,
  me,
}: {
  repo: string;
  processId: string;
  docPath: string;
  /** process.yaml version, when the route resolved it — stamped into todo anchors */
  processVersion?: string;
  me: Me;
}) {
  const notation = byExtension(docPath);
  const isBpmn = notation?.id === "bpmn";
  const fileName = docPath.split("/").pop() ?? docPath;
  const [owner = "", name = ""] = repo.split("/");

  const canvasRef = useRef<HTMLDivElement>(null);
  const xmlRef = useRef<HTMLDivElement>(null);
  const [status, setStatus] = useState<"connecting" | "slow" | "live" | "error">("connecting");
  const [error, setError] = useState<string | null>(null);
  const [showXml, setShowXml] = useState(!isBpmn);
  const [presence, setPresence] = useState<Presence[]>([]);

  // model-anchored todos — only for documents that belong to a process
  const hasTodos = processId.length > 0;
  const todosQuery = useTodos(repo, processId, hasTodos);
  const [selectedElements, setSelectedElements] = useState<TodoElementWire[]>([]);
  const [todosOpen, setTodosOpen] = useState(false);
  const [todoFilter, setTodoFilter] = useState<string | null>(null);
  const [todoCreateOpen, setTodoCreateOpen] = useState(false);
  // the canvas controller lives inside the imperative session effect; the query
  // data flows in through these refs (and the effect below) in either order
  const todoCanvasRef = useRef<TodoCanvas | null>(null);
  const todosRef = useRef<TodoWire[]>([]);

  const todoList = todosQuery.data;
  useEffect(() => {
    todosRef.current = todoList ?? [];
    todoCanvasRef.current?.setTodos(todosRef.current);
  }, [todoList]);

  useEffect(() => {
    let cancelled = false;
    const session = openLiveSession({
      url: config.wsUrl,
      // room name = <repo-full-name>/<repo-relative-path> (@bpmiq/contracts/live)
      room: roomName(repo, docPath),
      token: me.wsToken,
      onAuthenticationFailed: (reason) => {
        if (cancelled) return;
        setError(`Zugriff verweigert: ${reason}`);
        setStatus("error");
      },
    });
    session.setUser({ name: me.user.name || me.user.login, color: config.color });

    let modeler: InstanceType<typeof BpmnModeler> | undefined;
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
      if (isBpmn && canvasRef.current) {
        modeler = new BpmnModeler({ container: canvasRef.current });
        unbindCanvas = bindBpmn(modeler as never, ytext, session.doc, (msg) => toast.error(msg));
        if (hasTodos) {
          // badges re-attach on every import.done (bindBpmn re-imports remote
          // changes); a badge click opens the panel filtered to its element
          todoCanvas = attachTodoCanvas(modeler as never, {
            onBadgeClick: (elementId) => {
              setTodoFilter(elementId);
              setTodosOpen(true);
            },
            onSelectionChanged: setSelectedElements,
          });
          todoCanvasRef.current = todoCanvas;
          todoCanvas.setTodos(todosRef.current);
        }
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
      todoCanvas?.destroy();
      todoCanvasRef.current = null;
      unbindCanvas?.();
      monacoBinding?.destroy();
      xmlEditor?.dispose();
      xmlModel?.dispose();
      modeler?.destroy();
      session.destroy(); // provider AND socket
    };
  }, [repo, docPath, me.wsToken]);

  const release = useMutation({
    mutationFn: () => releaseProcess(repo, processId),
    onSuccess: ({ pr }) =>
      toast.success("Release erstellt", {
        description: pr,
        action: { label: "PR öffnen", onClick: () => window.open(pr, "_blank") },
        duration: 15_000,
      }),
    onError: (e) => toast.error((e as Error).message),
  });

  const xmlActive = showXml || !isBpmn;

  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center gap-2 border-b px-4 py-2">
        <Button asChild variant="ghost" size="icon" title="Zurück">
          <Link to="/r/$owner/$repo" params={{ owner, repo: name }}>
            <ArrowLeft />
          </Link>
        </Button>
        <span className="truncate text-sm font-medium">
          {repo} · {processId || fileName}
          {isBpmn ? "" : ` · ${fileName}`}
        </span>
        {status === "live" && <Badge variant="success">live</Badge>}
        {(status === "connecting" || status === "slow") && (
          <Badge variant="secondary">
            <Loader2 className="animate-spin" /> {status === "slow" ? "verbinde… (dauert)" : "verbinde…"}
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
        {isBpmn && (
          <Button variant="outline" size="sm" onClick={() => setShowXml((v) => !v)}>
            XML
          </Button>
        )}
        {hasTodos && (
          <>
            <Button
              variant="outline"
              size="sm"
              title="Offene Todos dieses Prozesses"
              onClick={() => {
                setTodoFilter(null);
                setTodosOpen((v) => !v);
              }}
            >
              <ListTodo />
              Todos{todoList && todoList.length > 0 ? ` (${todoList.length})` : ""}
            </Button>
            <Button
              variant="outline"
              size="sm"
              title={
                selectedElements.length > 0
                  ? "Todo an der Auswahl verankern"
                  : "Todo auf Prozess-Ebene anlegen (kein Element ausgewählt)"
              }
              onClick={() => setTodoCreateOpen(true)}
            >
              <Plus />
              Todo{selectedElements.length > 0 ? ` · ${selectedElements.length}` : ""}
            </Button>
          </>
        )}
        {processId && (
          <Button size="sm" disabled={release.isPending} onClick={() => release.mutate()}>
            {release.isPending ? "Validiere & PR…" : "Release → PR"}
          </Button>
        )}
      </div>
      {error && <div className="bg-destructive/10 text-destructive border-b px-4 py-2 text-sm">{error}</div>}
      <div className="relative min-h-0 flex-1">
        <div
          ref={canvasRef}
          className={cn("bpmn-canvas absolute inset-0", xmlActive && "pointer-events-none opacity-0")}
        />
        <div
          ref={xmlRef}
          className={cn("monaco-host absolute inset-0", !xmlActive && "pointer-events-none opacity-0")}
        />
        {hasTodos && todosOpen && (
          <TodoPanel
            todos={todoList}
            isLoading={todosQuery.isLoading}
            error={todosQuery.error}
            filterElementId={todoFilter}
            onClearFilter={() => setTodoFilter(null)}
            onRevealElement={(elementId) => {
              if (!todoCanvasRef.current?.reveal(elementId))
                toast(`Element '${elementId}' existiert nicht (mehr) im Diagramm.`);
            }}
            onClose={() => {
              setTodosOpen(false);
              setTodoFilter(null);
            }}
          />
        )}
      </div>
      {hasTodos && todoCreateOpen && (
        <TodoCreateDialog
          repo={repo}
          processId={processId}
          docPath={docPath}
          processVersion={processVersion}
          elements={selectedElements}
          onClose={() => setTodoCreateOpen(false)}
        />
      )}
    </div>
  );
}
