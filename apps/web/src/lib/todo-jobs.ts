/**
 * Following a background todo job (#208, #210) — a renamed process's todos
 * moving to its new id, a deleted one's closing. The tracker takes one change
 * at a time, so a job over many todos runs for a while; the user keeps
 * working and a toast carries the progress (Nielsen: past ~1 s show that it
 * works, past ~10 s show how far along it is). Module-level on purpose: the
 * rename sends its editor to a new route and the dialog is gone — the toast
 * must outlive both.
 */
import type { QueryClient } from "@tanstack/react-query";
import { toast } from "sonner";

import { fetchTodoJobs, retryTodoJob, type TodoJobWire } from "@/lib/api";

/** rough seconds per todo: a move is one tracker write, a close two — plus
 *  GitHub's second between writes (REST best practices) */
const SECONDS_PER_TODO = { move: 1.5, close: 2.5 } as const;

/** "about 20 s" / "about 2 min" — "" while it stays below a few seconds */
export function todoJobEstimate(count: number, kind: TodoJobWire["kind"]): string {
  const seconds = count * SECONDS_PER_TODO[kind];
  if (seconds < 5) return "";
  if (seconds < 90) return `about ${Math.ceil(seconds / 5) * 5} s`;
  return `about ${Math.round(seconds / 60)} min`;
}

export const todoCount = (n: number): string => `${n} todo${n === 1 ? "" : "s"}`;

/** why it takes a while — one line, next to the progress */
const WHY = "The tracker takes one change at a time — keep working, this runs in the background.";

const following = new Set<string>();

/** poll the job and mirror it into ONE toast until it is done or failed.
 *  `expected` = the todo count the caller already knows (the rename dialog
 *  showed it) — lets the toast say so while the job still waits its turn */
export function followTodoJob(repo: string, job: TodoJobWire, qc: QueryClient, expected = 0): void {
  const key = `${repo}|${job.id}`;
  if (following.has(key)) return;
  following.add(key);
  const toastId = `todo-job:${key}`;
  const doing = job.kind === "move" ? `Moving todos to '${job.to}'` : `Closing the todos of '${job.from}'`;
  let shown = false;

  const tick = async (): Promise<void> => {
    let current: TodoJobWire | undefined;
    try {
      current = (await fetchTodoJobs(repo)).find((j) => j.id === job.id);
    } catch {
      // the host is briefly unreachable — keep following
      setTimeout(() => void tick(), 2000);
      return;
    }
    if (!current) {
      following.delete(key);
      if (shown) toast.dismiss(toastId);
      return;
    }
    if (current.state === "queued" || current.state === "running") {
      // nothing to announce for a process without todos (total 0) or before
      // the job has looked (-1): a toast would flash for nothing
      if (current.total > 0 || (current.total === -1 && expected > 0)) {
        shown = true;
        toast.loading(
          current.total > 0 ? `${doing} · ${current.done} of ${current.total}` : `${doing} · ${todoCount(expected)}`,
          { id: toastId, description: WHY, duration: Number.POSITIVE_INFINITY },
        );
      }
      setTimeout(() => void tick(), 1000);
      return;
    }
    following.delete(key);
    void qc.invalidateQueries({ queryKey: ["todos", repo] });
    void qc.invalidateQueries({ queryKey: ["todo-jobs", repo] });
    if (current.state === "done") {
      if (current.total > 0) {
        toast.success(
          job.kind === "move"
            ? `${todoCount(current.done)} moved to '${job.to}'`
            : `${todoCount(current.done)} of '${job.from}' closed`,
          { id: toastId, description: undefined, duration: 4000 },
        );
      } else if (shown) toast.dismiss(toastId);
      return;
    }
    // failed: the todos it could not handle stay where they are — say which,
    // and offer the retry right here (the Todos panel offers it too)
    toast.error(
      current.total <= 0
        ? `The tracker could not be reached — the todos of '${job.from}' were not ${job.kind === "move" ? "moved" : "closed"}`
        : `${todoCount(current.failed)} could not be ${job.kind === "move" ? "moved" : "closed"}`,
      {
        id: toastId,
        description:
          job.kind === "move" ? `They stay filed under '${job.from}' until a retry moves them.` : "They stay open.",
        duration: Number.POSITIVE_INFINITY,
        action: {
          label: "Retry",
          onClick: () =>
            void retryTodoJob(repo, job.id)
              .then((again) => followTodoJob(repo, again, qc))
              .catch((e: Error) => toast.error(e.message)),
        },
      },
    );
  };
  void tick();
}
