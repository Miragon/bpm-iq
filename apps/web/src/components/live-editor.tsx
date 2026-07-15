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
import { ArrowLeft, Loader2 } from "lucide-react";
import * as monaco from "monaco-editor";
import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { MonacoBinding } from "y-monaco";

import { config, type Me, releaseProcess } from "@/lib/api";

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
  me,
}: {
  repo: string;
  processId: string;
  docPath: string;
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
      </div>
    </div>
  );
}
