/**
 * The one right-hand side-panel shell of the editor (todos, history, decision
 * checks) — aside, header row and close button were byte-identical three
 * times, and the third copy had already drifted (a full-foreground, shrinkable
 * icon). The badge slot is a ReactNode on purpose: the three panels' badges
 * are not one shape (count, analysis verdict, none-while-loading).
 */
import { Button } from "@bpmiq/ui-kit/components/button";
import type { LucideIcon } from "lucide-react";
import { X } from "lucide-react";
import type { ReactNode } from "react";

export function SidePanel({
  icon: Icon,
  title,
  badge,
  onClose,
  children,
}: {
  icon: LucideIcon;
  title: string;
  badge?: ReactNode;
  onClose: () => void;
  children: ReactNode;
}) {
  return (
    <aside className="bg-background absolute inset-y-0 right-0 z-10 flex w-80 flex-col border-l shadow-lg">
      <div className="flex items-center gap-2 border-b px-3 py-2">
        <Icon className="text-muted-foreground size-4 shrink-0" />
        <span className="text-sm font-medium">{title}</span>
        {badge}
        <div className="flex-1" />
        <Button variant="ghost" size="icon" className="size-7" title="Close" onClick={onClose}>
          <X />
        </Button>
      </div>
      {children}
    </aside>
  );
}
