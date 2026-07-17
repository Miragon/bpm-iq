/**
 * Side panel listing the open file's commit history on the default branch,
 * newest first. A row expands to the full message + actions: "Compare" opens
 * a diff of that commit against the LIVE document, "Restore" writes the
 * commit's content back into the live document — two-click confirm, because
 * it overwrites unreleased live edits for everyone in the session (the live
 * doc stays recoverable through this very history).
 */
import { Badge } from "@bpmiq/ui-kit/components/badge";
import { Button } from "@bpmiq/ui-kit/components/button";
import { cn } from "@bpmiq/ui-kit/lib/utils";
import { ChevronDown, ChevronRight, GitCompare, History, Loader2, RotateCcw, X } from "lucide-react";
import { useEffect, useState } from "react";

import { type FileCommitWire, HISTORY_LIMIT } from "@/lib/api";

const rtf = new Intl.RelativeTimeFormat("en", { numeric: "auto" });
const STEPS: [number, Intl.RelativeTimeFormatUnit][] = [
  [60 * 24 * 365, "year"],
  [60 * 24 * 30, "month"],
  [60 * 24 * 7, "week"],
  [60 * 24, "day"],
  [60, "hour"],
  [1, "minute"],
];

function timeAgo(iso: string): string {
  const then = Date.parse(iso);
  if (Number.isNaN(then)) return iso;
  const minutes = Math.round((then - Date.now()) / 60_000);
  for (const [size, unit] of STEPS) {
    if (Math.abs(minutes) >= size) return rtf.format(Math.trunc(minutes / size), unit);
  }
  return rtf.format(minutes, "minute");
}

function CommitItem({
  commit,
  latest,
  expanded,
  pending,
  busy,
  actionsEnabled,
  onToggle,
  onCompare,
  onRestore,
}: {
  commit: FileCommitWire;
  /** tip of the default branch — the released truth */
  latest: boolean;
  expanded: boolean;
  /** true while this row's content fetch (compare or restore) is in flight */
  pending: boolean;
  /** true while ANY row's fetch is in flight — one action at a time */
  busy: boolean;
  /** false until the live session is attached — the diff/restore target */
  actionsEnabled: boolean;
  onToggle: () => void;
  onCompare: () => void;
  onRestore: () => void;
}) {
  // restore overwrites live edits for everyone — arm on the first click
  const [confirmRestore, setConfirmRestore] = useState(false);
  useEffect(() => {
    if (!expanded) setConfirmRestore(false);
  }, [expanded]);

  const Chevron = expanded ? ChevronDown : ChevronRight;
  return (
    <div className="rounded-md border">
      <button type="button" className="flex w-full items-start gap-2 p-2.5 text-left" onClick={onToggle}>
        <Chevron className="text-muted-foreground mt-0.5 size-3.5 shrink-0" />
        <div className="min-w-0 flex-1">
          <p className={cn("text-sm leading-snug font-medium", !expanded && "truncate")}>{commit.subject}</p>
          <p className="text-muted-foreground mt-0.5 text-xs">
            {commit.author} · {timeAgo(commit.authoredAt)} · <span className="font-mono">{commit.sha.slice(0, 7)}</span>
          </p>
        </div>
        {latest && <Badge variant="outline">latest</Badge>}
      </button>
      {expanded && (
        <div className="border-t px-2.5 pt-2 pb-2.5">
          {commit.body && <p className="text-muted-foreground text-xs whitespace-pre-wrap">{commit.body}</p>}
          <p className={cn("text-muted-foreground font-mono text-[10px] break-all", commit.body && "mt-2")}>
            {commit.sha}
          </p>
          <p className="text-muted-foreground text-xs">{new Date(commit.authoredAt).toLocaleString()}</p>
          <div className="mt-2 flex gap-2">
            <Button
              variant="outline"
              size="sm"
              className="h-7 flex-1 text-xs"
              title="Diff this commit against the live document"
              disabled={!actionsEnabled || busy}
              onClick={onCompare}
            >
              {pending ? <Loader2 className="animate-spin" /> : <GitCompare />}
              Compare
            </Button>
            <Button
              variant={confirmRestore ? "destructive" : "outline"}
              size="sm"
              className="h-7 flex-1 text-xs"
              title="Write this commit's content into the live document (overwrites unreleased live edits)"
              disabled={!actionsEnabled || busy}
              onClick={() => {
                if (!confirmRestore) return setConfirmRestore(true);
                setConfirmRestore(false);
                onRestore();
              }}
            >
              <RotateCcw />
              {confirmRestore ? "Really restore?" : "Restore"}
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}

export function HistoryPanel({
  commits,
  isLoading,
  error,
  pendingSha,
  actionsEnabled,
  onCompare,
  onRestore,
  onClose,
}: {
  commits: FileCommitWire[] | undefined;
  isLoading: boolean;
  error: Error | null;
  /** sha whose content fetch (compare or restore) is currently in flight */
  pendingSha: string | null;
  actionsEnabled: boolean;
  onCompare: (commit: FileCommitWire) => void;
  onRestore: (commit: FileCommitWire) => void;
  onClose: () => void;
}) {
  const [expandedSha, setExpandedSha] = useState<string | null>(null);
  const list = commits ?? [];

  return (
    <aside className="bg-background absolute inset-y-0 right-0 z-10 flex w-80 flex-col border-l shadow-lg">
      <div className="flex items-center gap-2 border-b px-3 py-2">
        <History className="text-muted-foreground size-4 shrink-0" />
        <span className="text-sm font-medium">History</span>
        {!isLoading && !error && <Badge variant="secondary">{list.length}</Badge>}
        <div className="flex-1" />
        <Button variant="ghost" size="icon" className="size-7" title="Close" onClick={onClose}>
          <X />
        </Button>
      </div>
      <div className="flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto p-3">
        {error ? (
          <p className="text-destructive text-sm">{error.message}</p>
        ) : isLoading ? (
          <p className="text-muted-foreground text-sm">Loading…</p>
        ) : list.length === 0 ? (
          <p className="text-muted-foreground text-sm">No commits on the default branch touch this file yet.</p>
        ) : (
          <>
            {list.map((c, i) => (
              <CommitItem
                key={c.sha}
                commit={c}
                latest={i === 0}
                expanded={expandedSha === c.sha}
                pending={pendingSha === c.sha}
                busy={pendingSha !== null}
                actionsEnabled={actionsEnabled}
                onToggle={() => setExpandedSha((cur) => (cur === c.sha ? null : c.sha))}
                onCompare={() => onCompare(c)}
                onRestore={() => onRestore(c)}
              />
            ))}
            {list.length >= HISTORY_LIMIT && (
              <p className="text-muted-foreground text-xs">
                Showing the latest {HISTORY_LIMIT} commits — older history exists in git.
              </p>
            )}
          </>
        )}
      </div>
    </aside>
  );
}
