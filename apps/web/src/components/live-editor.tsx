/**
 * The collaborative editor shell — the EDITOR a notation gets comes from the
 * web plugin registry (@/notations/registry, epic #118 step 6):
 *
 *   plugin       → its visual editor (bpmn-js / dmn-js / …) mounted on the
 *                  shared Y.Text, plus its side panels, assist handoff and
 *                  history diff — the ENGINE chunks load lazily on mount
 *   no plugin    → Monaco text editor on the shared Y.Text, language from the
 *                  registry (OWM/TT/VC/Markdown live-edit as text)
 *
 * React owns the shell (toolbar, presence, release); the editor ENGINES stay
 * imperative — the mounted plugin / Monaco / Yjs live in refs inside one effect
 * whose cleanup tears the whole live session down (provider, sockets, bindings).
 */
import { type PresenceUser, roomName } from "@bpmiq/contracts/live";
import { openLiveSession } from "@bpmiq/live-client";
import { updateText } from "@bpmiq/live-client/text";
import { byExtension } from "@bpmiq/notations";
import { cn } from "@bpmiq/ui-kit/lib/utils";
import { useMutation } from "@tanstack/react-query";
import { History, ListTodo } from "lucide-react";
import * as monaco from "monaco-editor";
import { Suspense, useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { MonacoBinding } from "y-monaco";
import type * as Y from "yjs";

import { AssistMenu } from "@/components/assist-menu";
import { EditorToolbar, type ToolbarPanelItem } from "@/components/editor-toolbar";
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
  presenceColor,
  type TodoElementWire,
  type TodoWire,
} from "@/lib/api";
import type { PresenceSurface, RemotePresence } from "@/lib/presence-canvas";
import { useFileHistory, useTodos } from "@/lib/queries";
import { createRemoteCaretStyles } from "@/lib/remote-carets";
import type { TodoCanvas } from "@/lib/todo-canvas";
import { type EditorToolbarAction, type MountedEditor, webPlugin } from "@/notations/registry";

function monacoLanguage(docPath: string): string {
  const notation = byExtension(docPath);
  if (notation) return notation.monacoLanguage;
  if (docPath.endsWith(".yaml") || docPath.endsWith(".yml")) return "yaml";
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
  const plugin = webPlugin(notation?.id);
  const isVisual = plugin?.mountEditor !== undefined;
  // a STRUCTURED room's truth lives in the element maps, NOT in CONTENT_KEY —
  // a writable Monaco bound there would sync typed text to peers but never
  // reach disk/REST/history (silent loss). No text tab until the structured
  // text lane is properly wired (dark today: every shipped notation is text).
  const structuredDoc = notation?.docShape === "structured";
  // cosmetic special case: bpmn is the platform's primary notation — its label
  // badge stays hidden and the title shows the process id alone
  const isBpmn = notation?.id === "bpmn";
  const fileName = docPath.split("/").pop() ?? docPath;

  const canvasRef = useRef<HTMLDivElement>(null);
  const xmlRef = useRef<HTMLDivElement>(null);
  const [status, setStatus] = useState<"connecting" | "slow" | "live" | "error">("connecting");
  const [error, setError] = useState<string | null>(null);
  const [showXml, setShowXml] = useState(!isVisual);
  const [presence, setPresence] = useState<PresenceUser[]>([]);
  /** the mounted editor exposed an element surface (selection, reveal) */
  const [hasElements, setHasElements] = useState(false);
  /** header actions the mounted editor contributes (e.g. the t.BPM toggle) */
  const [editorActions, setEditorActions] = useState<EditorToolbarAction[]>([]);

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

  // plugin side panels — fed the debounced live text while open
  const [panelContent, setPanelContent] = useState("");

  // the ONE open side panel — the panels are mutually exclusive, and the rule
  // lives here instead of being hand-written into every toggle (one of the
  // five copies had already gone stale). Plugin panels join by their id.
  const [panel, setPanel] = useState<string | null>(null);
  const togglePanel = (name: string): void => {
    setTodoFilter(null);
    setPanel((current) => (current === name ? null : name));
  };
  const closePanel = (): void => {
    setTodoFilter(null);
    setPanel(null);
  };
  const activePanelSpec = plugin?.panels?.find((p) => p.id === panel);
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
    session.setUser({
      name: me.user.name || me.user.login,
      color: presenceColor(me.user.login),
      avatarUrl: me.user.avatarUrl,
    });
    // a doc-level CLOSE (e.g. an oversized update rejected server-side) kills
    // the document WITHOUT a ws reconnect — surfaced, or the session would
    // just silently stop syncing while looking live
    const offDocClose = session.onDocClose(() => {
      if (cancelled) return;
      setStatus("error");
      setError("The server closed this live document — reload the page to reconnect.");
    });

    // Presence fan-out (#115): ONE awareness subscription feeds the Monaco
    // remote-caret styles AND whatever canvas controller the mounted engine
    // attaches through ctx.presence. Peers without a user field haven't
    // announced themselves yet — nothing to render for them.
    const caretStyles = createRemoteCaretStyles();
    const remoteListeners = new Set<(peers: RemotePresence[]) => void>();
    let lastRemote: RemotePresence[] = [];
    const presenceSurface: PresenceSurface = {
      setLocal: (p) => session.setCanvasPresence(p),
      onRemote: (cb) => {
        remoteListeners.add(cb);
        cb(lastRemote);
        return () => remoteListeners.delete(cb);
      },
    };
    const offAwareness = session.onAwarenessStates((peers) => {
      lastRemote = peers.filter((p): p is RemotePresence => p.user !== undefined);
      caretStyles.update(lastRemote);
      for (const cb of remoteListeners) cb(lastRemote);
    });

    let mounted: MountedEditor | undefined;
    let monacoBinding: MonacoBinding | undefined;
    let xmlEditor: monaco.editor.IStandaloneCodeEditor | undefined;
    let xmlModel: monaco.editor.ITextModel | undefined;
    let offPresence: (() => void) | undefined;
    let attached = false;

    // Attach the editor ENGINES when the doc syncs — even if that takes longer
    // than the "slow" hint below (a Fly cell resuming from suspend + first clone
    // can exceed 10s). No hard timeout that abandons a late sync into a dead editor.
    const attach = async () => {
      if (cancelled || attached) return;
      attached = true;
      const ytext = session.content;
      contentRef.current = ytext;
      if (plugin?.mountEditor && canvasRef.current) {
        // the engine chunk loads HERE — the eager bundle carries no editor
        // engine. A failed chunk load (offline, stale deploy rotating hashed
        // asset URLs) must NOT strand the session: fall back to the text view
        // below — the ytext is already synced, editing works without the engine.
        let editor: MountedEditor | undefined;
        try {
          editor = await plugin.mountEditor(canvasRef.current, {
            ytext,
            doc: session.doc,
            docPath,
            onSyncError: (msg) => {
              if (!cancelled) toast.error(msg);
            },
            onImportFailed: (msg) => {
              if (cancelled) return; // an in-flight first import can settle after unmount
              toast.error(`${notation?.label ?? "Model"} import failed: ${msg}`);
              setShowXml(true);
            },
            onBadgeClick: (elementId) => {
              setTodoFilter(elementId);
              setPanel("todos");
            },
            onSelectionChanged: setSelectedElements,
            presence: presenceSurface,
          });
        } catch (e) {
          if (!cancelled) {
            toast.error(
              `${notation?.label ?? "Model"} editor failed to load (${e instanceof Error ? e.message : String(e)}) — falling back to the text view.`,
            );
            setShowXml(true);
          }
        }
        if (cancelled) {
          // unmounted while the chunk loaded — tear the late editor down
          editor?.destroy();
          return;
        }
        mounted = editor;
        setEditorActions(editor?.actions ?? []);
        if (editor?.elements) {
          setHasElements(true);
          todoCanvasRef.current = editor.elements;
          editor.elements.setTodos(todosRef.current);
          if (pendingRevealRef.current) {
            // deep link opened before the session synced — arm the one-shot now
            editor.elements.revealOnce(pendingRevealRef.current);
            pendingRevealRef.current = null;
          }
        }
      }
      if (cancelled) return;
      if (xmlRef.current && !structuredDoc) {
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
    const offSynced = session.onSynced(() => void attach());
    // still connecting after 10s → tell the user it's taking a while, keep waiting
    const slow = setTimeout(() => {
      if (!cancelled && !attached) setStatus("slow");
    }, 10_000);

    return () => {
      cancelled = true;
      clearTimeout(slow);
      offSynced();
      offPresence?.();
      offAwareness();
      offDocClose();
      caretStyles.destroy();
      contentRef.current = null;
      todoCanvasRef.current = null;
      setEditorActions([]);
      mounted?.destroy();
      monacoBinding?.destroy();
      xmlEditor?.dispose();
      xmlModel?.dispose();
      session.destroy(); // provider AND socket
    };
  }, [repo, docPath, me.wsToken]);

  // Feed the open plugin panel from the shared Y.Text — only while it is OPEN,
  // and debounced: re-analysing on every keystroke of a co-editor would be pure
  // waste (`status` re-runs this once the session attached contentRef).
  useEffect(() => {
    const ytext = activePanelSpec ? contentRef.current : null;
    if (!ytext) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const sync = () => setPanelContent(ytext.toString());
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
  }, [activePanelSpec, status]);

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

  const xmlActive = (showXml || !isVisual) && !structuredDoc;
  const ActivePanel = activePanelSpec?.component;

  // the notation plugin's panels and the shell's own (todos, history) are the
  // same KIND of thing to the user, so they render the same way and carry the
  // same open/closed state — split only by PLACEMENT: everyday toggles keep
  // their bar button, occasional ones (Notes, History) live in the ⋯ menu
  const pluginPanels = (plugin?.panels ?? []).map((p) => ({
    id: p.id,
    label: p.label,
    title: p.buttonTitle,
    icon: p.icon,
    placement: p.placement,
  }));
  const toolbarPanels: ToolbarPanelItem[] = [
    ...pluginPanels.filter((p) => p.placement !== "menu"),
    ...(hasTodos
      ? [
          {
            id: "todos",
            label: "Todos",
            title: "Open todos for this process",
            icon: ListTodo,
            count: todoList?.length,
          },
        ]
      : []),
  ];
  const menuPanels: ToolbarPanelItem[] = [
    ...pluginPanels.filter((p) => p.placement === "menu"),
    { id: "history", label: "History", title: "History of this file on the default branch", icon: History },
  ];

  return (
    <div className="flex h-full flex-col">
      <EditorToolbar
        repo={repo}
        title={processId || fileName}
        subtitle={!isBpmn && processId ? fileName : undefined}
        backDir={backDir}
        notationLabel={notation && !isBpmn ? notation.label : undefined}
        status={status}
        presence={presence}
        modeActions={editorActions}
        view={
          isVisual && !structuredDoc
            ? {
                sourceLabel: notation?.mediaKind === "xml" ? "XML" : notation?.mediaKind === "json" ? "JSON" : "Text",
                showSource: showXml,
                onChange: setShowXml,
              }
            : undefined
        }
        panels={toolbarPanels}
        menuPanels={menuPanels}
        activePanel={panel}
        onTogglePanel={togglePanel}
        addTodo={
          hasTodos ? { selectionCount: selectedElements.length, onAdd: () => setTodoCreateOpen(true) } : undefined
        }
        assist={
          plugin?.assistNotation ? (
            <AssistMenu
              repo={repo}
              path={docPath}
              notation={plugin.assistNotation}
              selection={hasElements ? selectedElements : undefined}
            />
          ) : undefined
        }
        onRelease={() => setReleaseOpen(true)}
      />
      {error && <div className="bg-destructive/10 text-destructive border-b px-4 py-2 text-sm">{error}</div>}
      <div className="relative min-h-0 flex-1">
        <div
          ref={canvasRef}
          className={cn(plugin?.canvasClassName, "absolute inset-0", xmlActive && "pointer-events-none opacity-0")}
        />
        <div
          ref={xmlRef}
          className={cn("monaco-host absolute inset-0", !xmlActive && "pointer-events-none opacity-0")}
        />
        {ActivePanel && (
          <Suspense fallback={null}>
            <ActivePanel
              repo={repo}
              docPath={docPath}
              content={panelContent}
              onRevealElement={
                hasElements
                  ? (elementId) => {
                      const found = todoCanvasRef.current?.reveal(elementId) ?? false;
                      if (found) setShowXml(false); // a reveal must be VISIBLE, not on the hidden canvas
                      return found;
                    }
                  : undefined
              }
              onClose={closePanel}
            />
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
          diagramDiff={plugin?.diff}
          restorePending={restore.isPending}
          onRestore={() => restore.mutate(diff.commit)}
          onClose={() => setDiff(null)}
        />
      )}
      {releaseOpen && <ReleaseDialog repo={repo} preselect={[docPath]} onClose={() => setReleaseOpen(false)} />}
    </div>
  );
}
