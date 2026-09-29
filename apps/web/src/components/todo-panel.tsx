/**
 * Compact side panel listing the OPEN todos of the current process. Element
 * chips reveal (select + scroll) their element on the canvas; badge clicks on
 * the canvas open this panel pre-filtered to that element. Todos whose anchor
 * elements no longer exist stay listed — only the reveal is unavailable.
 * "Done" closes the todo in the tracker (confirm-less): the row dims while
 * the POST is pending, disappears on success (badges/counts follow via the
 * shared query cache), and close errors surface inline above the list.
 *
 * After a rename (#208) the process's todos move to its new id in the
 * background, one tracker change at a time: the panel lists them all along
 * (the server merges the ones still under the old id) and says how far the
 * move is — or, when the tracker refused some, which old id still holds
 * them, with a Retry.
 */
import { Badge } from "@bpmiq/ui-kit/components/badge";
import { Button } from "@bpmiq/ui-kit/components/button";
import { cn } from "@bpmiq/ui-kit/lib/utils";
import { Check, CircleAlert, ExternalLink, ListTodo, Loader2 } from "lucide-react";

import { SidePanel } from "@/components/side-panel";
import type { TodoWire } from "@/lib/api";
import { useCloseTodo, useRetryTodoJob, useTodoJobs } from "@/lib/queries";
import { todoCount } from "@/lib/todo-jobs";
import {
  closeInTrackerTitle,
  elementLabel,
  emptyTodoMessage,
  openInTrackerTitle,
  todosForElement,
} from "@/lib/todo-view";

function TodoItem({
  todo,
  closing,
  onRevealElement,
  onCloseTodo,
}: {
  todo: TodoWire;
  /** true while this row's close POST is pending — row dims, button disables */
  closing: boolean;
  onRevealElement: (elementId: string) => void;
  onCloseTodo: () => void;
}) {
  return (
    <div className={cn("rounded-md border p-2.5", closing && "pointer-events-none opacity-50")}>
      <div className="flex items-start gap-2">
        <p className="flex-1 text-sm leading-snug font-medium">{todo.title}</p>
        <a
          href={todo.url}
          target="_blank"
          rel="noreferrer"
          title={openInTrackerTitle(todo.id)}
          className="text-muted-foreground hover:text-foreground mt-0.5 shrink-0"
        >
          <ExternalLink className="size-3.5" />
        </a>
      </div>
      {todo.anchor && todo.anchor.elements.length > 0 && (
        <div className="mt-1.5 flex flex-wrap gap-1">
          {todo.anchor.elements.map((el) => (
            <button key={el.id} type="button" title={el.id} onClick={() => onRevealElement(el.id)}>
              <Badge variant="outline" className="hover:bg-accent max-w-48 cursor-pointer">
                <span className="truncate">{el.name ?? el.id}</span>
              </Badge>
            </button>
          ))}
        </div>
      )}
      <div className="text-muted-foreground mt-1.5 flex flex-wrap items-center gap-x-2 text-xs">
        <span>#{todo.id}</span>
        {todo.assignees.length > 0 && <span>{todo.assignees.map((a) => `@${a}`).join(", ")}</span>}
        <Button
          variant="ghost"
          size="sm"
          className="text-muted-foreground hover:text-foreground ml-auto h-6 gap-1 px-1.5 text-xs font-normal"
          title={closeInTrackerTitle(todo.id)}
          disabled={closing}
          onClick={onCloseTodo}
        >
          <Check className="size-3.5" />
          {closing ? "Closing…" : "Done"}
        </Button>
      </div>
    </div>
  );
}

/** the move of a renamed process's todos INTO this process — running or failed */
function IncomingTodos({ repo, processId }: { repo: string; processId: string }) {
  const jobs = useTodoJobs(repo);
  const retry = useRetryTodoJob(repo);
  const incoming = (jobs.data ?? []).filter((j) => j.kind === "move" && j.to === processId && j.state !== "done");
  if (incoming.length === 0) return null;
  return (
    <div className="space-y-1.5 border-b px-3 py-2 text-xs" role="status">
      {incoming.map((j) =>
        j.state === "failed" ? (
          <div key={j.id} className="flex items-start gap-2">
            <CircleAlert className="text-warning mt-px size-3.5 shrink-0" />
            <p className="min-w-0 flex-1">
              {j.total <= 0
                ? `The tracker could not be reached — the todos of '${j.from}' are not moved yet.`
                : `${todoCount(j.failed)} could not be moved and ${j.failed === 1 ? "is" : "are"} still filed under '${j.from}'.`}
            </p>
            <Button
              variant="outline"
              size="sm"
              className="h-6 shrink-0 px-2 text-xs"
              disabled={retry.isPending}
              onClick={() => retry.mutate(j.id)}
            >
              Retry
            </Button>
          </div>
        ) : (
          <div key={j.id} className="text-muted-foreground flex items-start gap-2">
            <Loader2 className="mt-px size-3.5 shrink-0 animate-spin motion-reduce:animate-none" />
            <p className="min-w-0 flex-1">
              {j.total > 0
                ? `Moving the todos of '${j.from}' here — ${j.done} of ${j.total}.`
                : `Moving the todos of '${j.from}' here…`}{" "}
              They are listed already.
            </p>
          </div>
        ),
      )}
    </div>
  );
}

export function TodoPanel({
  repo,
  processId,
  todos,
  isLoading,
  error,
  filterElementId,
  onClearFilter,
  onRevealElement,
  onClose,
}: {
  repo: string;
  /** the process the panel lists — a rename's todo move INTO it shows here */
  processId: string;
  todos: TodoWire[] | undefined;
  isLoading: boolean;
  error: Error | null;
  /** element id a canvas badge was clicked on — narrows the list to its todos */
  filterElementId: string | null;
  onClearFilter: () => void;
  onRevealElement: (elementId: string) => void;
  onClose: () => void;
}) {
  const closeTodo = useCloseTodo(repo);
  const all = todos ?? [];
  const list = filterElementId ? todosForElement(all, filterElementId) : all;
  // creation-time name snapshot of the filtered element, if any todo carries one
  const filterName = filterElementId ? elementLabel(all, filterElementId) : null;

  return (
    <SidePanel
      icon={ListTodo}
      title="Open todos"
      badge={!isLoading && !error && <Badge variant="secondary">{list.length}</Badge>}
      onClose={onClose}
    >
      {filterElementId && (
        <div className="flex items-center gap-2 border-b px-3 py-1.5">
          <span className="text-muted-foreground shrink-0 text-xs">Element:</span>
          <Badge variant="outline" className="max-w-40" title={filterElementId}>
            <span className="truncate">{filterName}</span>
          </Badge>
          <Button variant="ghost" size="sm" className="ml-auto h-6 px-2 text-xs" onClick={onClearFilter}>
            Show all
          </Button>
        </div>
      )}
      <IncomingTodos repo={repo} processId={processId} />
      <div className="flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto p-3">
        {closeTodo.error && (
          <p className="text-destructive text-sm">
            Could not close todo #{closeTodo.variables}: {closeTodo.error.message}
          </p>
        )}
        {error ? (
          <p className="text-destructive text-sm">{error.message}</p>
        ) : isLoading ? (
          <p className="text-muted-foreground text-sm">Loading…</p>
        ) : list.length === 0 ? (
          <p className="text-muted-foreground text-sm">{emptyTodoMessage(filterElementId !== null)}</p>
        ) : (
          list.map((t) => (
            <TodoItem
              key={t.id}
              todo={t}
              closing={closeTodo.isPending && closeTodo.variables === t.id}
              onRevealElement={onRevealElement}
              onCloseTodo={() => closeTodo.mutate(t.id)}
            />
          ))
        )}
      </div>
    </SidePanel>
  );
}
