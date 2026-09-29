/**
 * The shell of the model dialogs (rename, duplicate, move, delete — #208–#210):
 * dimmed backdrop, a centered form panel, header + blurb, right-aligned footer.
 * Escape and a backdrop click close it — never while the action runs (an
 * unmounted dialog would drop the mutation's onSuccess). Mounted on open, so
 * state resets by unmounting (create-dialog convention).
 */
import { Button } from "@bpmiq/ui-kit/components/button";
import { cn } from "@bpmiq/ui-kit/lib/utils";
import { type ReactNode, useEffect, useId } from "react";

export const fieldClass =
  "border-input bg-background focus-visible:ring-ring/50 focus-visible:border-ring mt-1 w-full rounded-md border px-3 py-2 text-sm shadow-xs outline-none focus-visible:ring-[3px]";

export function DialogShell({
  title,
  blurb,
  pending,
  error,
  submitLabel,
  pendingLabel,
  submitDisabled,
  destructive = false,
  wide = false,
  onSubmit,
  onClose,
  children,
}: {
  title: ReactNode;
  blurb?: ReactNode;
  pending: boolean;
  error?: Error | null;
  submitLabel: string;
  pendingLabel: string;
  submitDisabled?: boolean;
  /** the primary action destroys something — red, never the default blue */
  destructive?: boolean;
  wide?: boolean;
  onSubmit: () => void;
  onClose: () => void;
  children?: ReactNode;
}) {
  const titleId = useId();
  const close = () => {
    if (!pending) onClose();
  };
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !pending) onClose();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [onClose, pending]);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4" onClick={close}>
      <form
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        className={cn(
          "bg-background flex max-h-[85vh] w-full flex-col rounded-lg border p-4 shadow-lg",
          wide ? "max-w-lg" : "max-w-md",
        )}
        onClick={(e) => e.stopPropagation()}
        onSubmit={(e) => {
          e.preventDefault();
          if (!pending && !submitDisabled) onSubmit();
        }}
      >
        <h2 id={titleId} className="text-sm font-semibold">
          {title}
        </h2>
        {blurb && <p className="text-muted-foreground mt-1.5 text-xs">{blurb}</p>}
        {children}
        {error && (
          <p className="text-destructive mt-3 text-sm" role="alert">
            {error.message}
          </p>
        )}
        <div className="mt-4 flex justify-end gap-2">
          <Button type="button" variant="outline" size="sm" onClick={onClose} disabled={pending}>
            Cancel
          </Button>
          <Button
            type="submit"
            size="sm"
            variant={destructive ? "destructive" : "default"}
            disabled={pending || submitDisabled}
          >
            {pending ? pendingLabel : submitLabel}
          </Button>
        </div>
      </form>
    </div>
  );
}

/** one consequence line of a dialog — icon + text, muted unless it warns */
export function Consequence({
  icon: Icon,
  tone = "muted",
  children,
}: {
  icon: React.ComponentType<{ className?: string }>;
  tone?: "muted" | "warning" | "danger";
  children: ReactNode;
}) {
  return (
    <li
      className={cn(
        "flex gap-2 text-xs",
        tone === "muted" && "text-muted-foreground",
        tone === "warning" && "text-foreground",
        tone === "danger" && "text-destructive",
      )}
    >
      <Icon
        className={cn(
          "mt-px size-3.5 shrink-0",
          tone === "warning" && "text-warning",
          tone === "danger" && "text-destructive",
        )}
      />
      <span className="min-w-0">{children}</span>
    </li>
  );
}
