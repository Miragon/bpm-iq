/**
 * What the model dialogs (rename, duplicate, move, delete — #208–#210) know
 * about a model, whether they were opened from an overview row or from the
 * open editor, plus the two client-side mirrors of server rules they need:
 * the file a model gets under a new id, and where a model opens.
 */
import { byExtension, byId, modelStem } from "@designiq/notations";
import { useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";

import { fetchProcesses } from "@/lib/api";

export interface ModelTarget {
  /** repo-relative path of the model file */
  path: string;
  /** its id — the file stem */
  id: string;
  /** notation registry id */
  notation: string;
  /** processes-root-relative folder ("" = root) */
  folder: string;
  /** people with it open right now */
  liveSessions: number;
  /** unreleased live changes */
  dirty: boolean;
}

export function modelTarget(path: string, row: { folder: string; liveSessions: number; dirty: boolean }): ModelTarget {
  return {
    path,
    id: modelStem(path),
    notation: byExtension(path)?.id ?? "text",
    folder: row.folder,
    liveSessions: row.liveSessions,
    dirty: row.dirty,
  };
}

/** "process", "decision", "wardley map" … */
export const nounOf = (notation: string): string => byId(notation)?.noun.singular ?? "model";

/** the path the model gets under `id` — same folder, same extension (the
 *  server's rule, application/scaffold.ts pathUnderId) */
export function pathUnderId(target: Pick<ModelTarget, "path" | "id">, id: string): string {
  const slash = target.path.lastIndexOf("/");
  const file = target.path.slice(slash + 1);
  return `${target.path.slice(0, slash + 1)}${id}${file.slice(target.id.length)}`;
}

/** references resolve by id — only these notations can be pointed at */
export const isReferenceable = (notation: string): boolean => notation === "bpmn" || notation === "dmn";

/**
 * Open a model by path: a process on its /p/<id> route, everything else on
 * /f/<path>. The process route resolves the id against the CACHED process
 * list, so a model that was just created or renamed is fetched first — and
 * when the list does not have it yet (a peer following a rename that is still
 * being written), the file route opens it all the same.
 */
export function useOpenModel(repo: string) {
  const navigate = useNavigate();
  const qc = useQueryClient();
  const [owner = "", name = ""] = repo.split("/");
  return async (path: string, opts: { replace?: boolean } = {}): Promise<void> => {
    if (byExtension(path)?.id === "bpmn") {
      const id = modelStem(path);
      const processes = await qc
        .fetchQuery({ queryKey: ["processes", repo], queryFn: () => fetchProcesses(repo), staleTime: 0 })
        .catch(() => []);
      if (processes.some((p) => p.id === id)) {
        await navigate({
          to: "/r/$owner/$repo/p/$processId",
          params: { owner, repo: name, processId: id },
          replace: opts.replace,
        });
        return;
      }
    }
    await navigate({ to: "/r/$owner/$repo/f/$", params: { owner, repo: name, _splat: path }, replace: opts.replace });
  };
}

/** renames THIS tab asked for — its own editor then follows the moved notice
 *  silently (the rename's toast already says it), while a colleague's
 *  editor announces who renamed the model */
const expectedMoves = new Set<string>();

export function expectMove(path: string): void {
  expectedMoves.add(path);
  setTimeout(() => expectedMoves.delete(path), 30_000);
}

/** true (once) when this tab asked for the move to `path` */
export function wasExpected(path: string): boolean {
  return expectedMoves.delete(path);
}
