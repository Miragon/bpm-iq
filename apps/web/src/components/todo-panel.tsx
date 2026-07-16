/**
 * Compact side panel listing the OPEN todos of the current process. Element
 * chips reveal (select + scroll) their element on the canvas; badge clicks on
 * the canvas open this panel pre-filtered to that element. Todos whose anchor
 * elements no longer exist stay listed — only the reveal is unavailable.
 */
import { Badge } from "@bpmiq/ui-kit/components/badge";
import { Button } from "@bpmiq/ui-kit/components/button";
import { ExternalLink, ListTodo, X } from "lucide-react";

import type { TodoWire } from "@/lib/api";

function TodoItem({ todo, onRevealElement }: { todo: TodoWire; onRevealElement: (elementId: string) => void }) {
  return (
    <div className="rounded-md border p-2.5">
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
      </div>
    </div>
  );
}

export function TodoPanel({
  todos,
  isLoading,
  error,
  filterElementId,
  onClearFilter,
  onRevealElement,
  onClose,
}: {
  todos: TodoWire[] | undefined;
  isLoading: boolean;
  error: Error | null;
  /** element id a canvas badge was clicked on — narrows the list to its todos */
  filterElementId: string | null;
  onClearFilter: () => void;
  onRevealElement: (elementId: string) => void;
  onClose: () => void;
}) {
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
        {error ? (
          <p className="text-destructive text-sm">{error.message}</p>
        ) : isLoading ? (
          <p className="text-muted-foreground text-sm">Lade …</p>
        ) : list.length === 0 ? (
          <p className="text-muted-foreground text-sm">
            {filterElementId ? "Keine offenen Todos an diesem Element." : "Keine offenen Todos für diesen Prozess."}
          </p>
        ) : (
          list.map((t) => <TodoItem key={t.id} todo={t} onRevealElement={onRevealElement} />)
        )}
      </div>
    </aside>
  );
}
