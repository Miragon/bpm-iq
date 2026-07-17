import { Button } from "@bpmiq/ui-kit/components/button";
import { getRouteApi, Link } from "@tanstack/react-router";
import { Loader2 } from "lucide-react";

import { LiveEditor } from "@/components/live-editor";
import { useDecisions, useMe, useProcesses } from "@/lib/queries";

const processRoute = getRouteApi("/r/$owner/$repo/p/$processId");
const fileRoute = getRouteApi("/r/$owner/$repo/f/$");

function Loading() {
  return (
    <div className="flex items-center justify-center py-24">
      <Loader2 className="text-muted-foreground size-6 animate-spin" />
    </div>
  );
}

function NotFound({ repo, msg }: { repo: string; msg: string }) {
  const [owner = "", name = ""] = repo.split("/");
  return (
    <div className="mx-auto max-w-2xl px-6 py-16 text-center">
      <p className="text-muted-foreground text-sm">{msg}</p>
      <Button asChild variant="outline" size="sm" className="mt-4">
        <Link to="/r/$owner/$repo" params={{ owner, repo: name }}>
          Back to {repo}
        </Link>
      </Button>
    </div>
  );
}

export function ProcessEditorScreen() {
  const { owner, repo: name, processId } = processRoute.useParams();
  // deep-link target (?element=<id>) — revealed once after the first diagram import
  const { element } = processRoute.useSearch();
  const repo = `${owner}/${name}`;
  const me = useMe();
  const processes = useProcesses(repo);
  if (me.isLoading || processes.isLoading) return <Loading />;
  if (!me.data) return null;
  // distinguish a fetch failure from a real "no BPMN model" — with retry:false,
  // data is also undefined when the query errored (don't mislabel a 500/network error)
  if (processes.isError) return <NotFound repo={repo} msg={(processes.error as Error).message} />;
  const proc = processes.data?.find((p) => p.id === processId);
  if (!proc) return <NotFound repo={repo} msg={`Process '${processId}' has no BPMN model.`} />;
  return (
    <LiveEditor
      key={`${repo}/${proc.bpmn}`}
      repo={repo}
      processId={processId}
      docPath={proc.bpmn}
      backDir={proc.folder}
      revealElementId={element}
      me={me.data}
    />
  );
}

export function FileEditorScreen() {
  const { owner, repo: name, _splat } = fileRoute.useParams();
  const repo = `${owner}/${name}`;
  const path = _splat ?? "";
  const me = useMe();
  // a process is a file — resolve the id (for todos/release) from the listing
  const processes = useProcesses(repo);
  const proc = processes.data?.find((p) => p.models.some((m) => m.path === path));
  // a decision is a file too — its row carries the folder the Back arrow returns to
  const decisions = useDecisions(repo);
  const decision = decisions.data?.find((d) => d.path === path);
  if (me.isLoading) return <Loading />;
  if (!me.data) return null;
  return (
    <LiveEditor
      key={`${repo}/${path}`}
      repo={repo}
      processId={proc?.id ?? ""}
      docPath={path}
      backDir={proc?.folder ?? decision?.folder}
      me={me.data}
    />
  );
}
