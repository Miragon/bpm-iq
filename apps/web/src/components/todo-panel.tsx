/**
 * Compact side panel listing the OPEN todos of the current process. Element
 * chips reveal (select + scroll) their element on the canvas; badge clicks on
 * the canvas open this panel pre-filtered to that element. Todos whose anchor
 * elements no longer exist stay listed — only the reveal is unavailable.
 * "Erledigt" closes the todo in the tracker (confirm-less): the row dims while
 * the POST is pending, disappears on success (badges/counts follow via the
 * shared query cache), and close errors surface inline above the list.
 */
import { Badge } from "@bpmiq/ui-kit/components/badge";
import { Button } from "@bpmiq/ui-kit/components/button";
import { cn } from "@bpmiq/ui-kit/lib/utils";
import { Check, ExternalLink, ListTodo, X } from "lucide-react";

import type { TodoWire } from "@/lib/api";
import { useCloseTodo } from "@/lib/queries";

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
          title={`#${todo.id} im Tracker öffnen`}
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
          title={`#${todo.id} im Tracker schließen`}
          disabled={closing}
          onClick={onCloseTodo}
        >
          <Check className="size-3.5" />
          {closing ? "Schließe …" : "Erledigt"}
        </Button>
      </div>
    </div>
  );
}

export function TodoPanel({
  repo,
  todos,
  isLoading,
  error,
  filterElementId,
  onClearFilter,
  onRevealElement,
  onClose,
}: {
  repo: string;
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
  const list = filterElementId ? all.filter((t) => t.anchor?.elements.some((el) => el.id === filterElementId)) : all;
  // creation-time name snapshot of the filtered element, if any todo carries one
  const filterName = filterElementId
    ? (all.flatMap((t) => t.anchor?.elements ?? []).find((el) => el.id === filterElementId && el.name)?.name ??
      filterElementId)
    : null;

  return (
    <aside className="bg-background absolute inset-y-0 right-0 z-10 flex w-80 flex-col border-l shadow-lg">
      <div className="flex items-center gap-2 border-b px-3 py-2">
        <ListTodo className="text-muted-foreground size-4 shrink-0" />
        <span className="text-sm font-medium">Offene Todos</span>
        {!isLoading && !error && <Badge variant="secondary">{list.length}</Badge>}
        <div className="flex-1" />
        <Button variant="ghost" size="icon" className="size-7" title="Schließen" onClick={onClose}>
          <X />
        </Button>
      </div>
      {filterElementId && (
        <div className="flex items-center gap-2 border-b px-3 py-1.5">
          <span className="text-muted-foreground shrink-0 text-xs">Element:</span>
          <Badge variant="outline" className="max-w-40" title={filterElementId}>
            <span className="truncate">{filterName}</span>
          </Badge>
          <Button variant="ghost" size="sm" className="ml-auto h-6 px-2 text-xs" onClick={onClearFilter}>
            Alle zeigen
          </Button>
        </div>
      )}
      <div className="flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto p-3">
        {closeTodo.error && (
          <p className="text-destructive text-sm">
            Todo #{closeTodo.variables} konnte nicht geschlossen werden: {closeTodo.error.message}
          </p>
        )}
        {error ? (
          <p className="text-destructive text-sm">{error.message}</p>
        ) : isLoading ? (
          <p className="text-muted-foreground text-sm">Lade …</p>
        ) : list.length === 0 ? (
          <p className="text-muted-foreground text-sm">
            {filterElementId ? "Keine offenen Todos an diesem Element." : "Keine offenen Todos für diesen Prozess."}
          </p>
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
    </aside>
  );
}
