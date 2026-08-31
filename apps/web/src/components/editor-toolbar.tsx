/**
 * The editor's one chrome bar. It carries five different KINDS of thing, and
 * the layout now says which is which instead of nine identical outline buttons
 * in a row:
 *
 *   identity   where you are — repo / model, connection, notation
 *   modes      document-level switches (t.BPM workshop mode) — they change the
 *              canvas FOR EVERYONE, so they sit with the document, not with
 *              the personal tools, and read as "on" when they are
 *   presence   who else is here — capped, the rest collapse into +N
 *   view       what you are looking at — a segmented Diagram | Source switch
 *              that states the CURRENT view (the old lone "XML" button did not)
 *   panels     what is docked beside the canvas — ONE cluster of toggles that
 *              show their open state. A notation plugin joins the cluster; it
 *              no longer grows the bar by another labelled button.
 *   actions    what you can do here (add todo, analyse with AI)
 *   menu       the ⋯ overflow, last: the occasional moves — panel toggles that
 *              earn no permanent button (Notes, History; open state shows as a
 *              check) and Release → PR
 *
 * Tool labels collapse to icon + tooltip through container queries as the bar
 * narrows, cheapest first: the actions go at @7xl (a sparkle and a list-plus
 * are guessable), the panel names hold on to @6xl (they are the labels a
 * once-a-month process owner actually needs), the view switch to @4xl.
 */
import type { PresenceUser } from "@bpmiq/contracts/live";
import { Badge } from "@bpmiq/ui-kit/components/badge";
import { Button } from "@bpmiq/ui-kit/components/button";
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@bpmiq/ui-kit/components/dropdown-menu";
import { cn } from "@bpmiq/ui-kit/lib/utils";
import { Link } from "@tanstack/react-router";
import { ArrowLeft, Code, Ellipsis, GitPullRequest, ListPlus, Loader2, Shapes } from "lucide-react";
import { type ComponentType, type ReactNode, useEffect, useState } from "react";

import { safeAvatarUrl, safePresenceColor } from "@/lib/presence-format";
import type { EditorToolbarAction } from "@/notations/registry";

export type EditorStatus = "connecting" | "slow" | "live" | "error";

/** a panel toggle — the shell's own (Todos, History) and the notation
 *  plugin's (Notes, Checks) render identically on purpose, whether they sit
 *  in the bar's cluster or in the ⋯ menu */
export interface ToolbarPanelItem {
  id: string;
  label: string;
  title: string;
  icon: ComponentType<{ className?: string }>;
  /** live count on the button (open todos); 0/undefined renders nothing */
  count?: number;
}

/** faces beyond this collapse into a +N chip — a busy workshop must not push
 *  the tools off the bar */
const MAX_AVATARS = 4;

export function EditorToolbar({
  repo,
  title,
  subtitle,
  backDir,
  notationLabel,
  status,
  presence,
  modeActions,
  view,
  panels,
  menuPanels,
  activePanel,
  onTogglePanel,
  addTodo,
  assist,
  onRelease,
}: {
  /** repository full name, "owner/name" */
  repo: string;
  /** the model's own name — process id, or the file name */
  title: string;
  /** the file behind the title, when it is not the title itself */
  subtitle?: string;
  /** processes-root-relative folder the Back arrow returns to ("" = root) */
  backDir?: string;
  notationLabel?: string;
  status: EditorStatus;
  presence: PresenceUser[];
  /** document modes contributed by the mounted editor engine */
  modeActions: EditorToolbarAction[];
  /** the Diagram | Source switch — absent when the doc has no visual editor */
  view?: { sourceLabel: string; showSource: boolean; onChange(showSource: boolean): void };
  panels: ToolbarPanelItem[];
  /** panel toggles living in the ⋯ overflow menu instead of the cluster */
  menuPanels: ToolbarPanelItem[];
  activePanel: string | null;
  onTogglePanel(id: string): void;
  addTodo?: { selectionCount: number; onAdd(): void };
  /** the Analyse-with-AI menu (owns its own trigger button) */
  assist?: ReactNode;
  onRelease(): void;
}) {
  const [owner = "", name = ""] = repo.split("/");
  const shownPeers = presence.slice(0, MAX_AVATARS);
  const hiddenPeers = presence.slice(MAX_AVATARS);

  return (
    <header className="@container bg-background flex items-center gap-2 border-b px-3 py-2">
      <Button asChild variant="ghost" size="icon" className="size-8 shrink-0" title={`Back to ${repo}`}>
        <Link to="/r/$owner/$repo" params={{ owner, repo: name }} search={backDir ? { dir: backDir } : {}}>
          <ArrowLeft />
        </Link>
      </Button>

      <div className="flex min-w-0 flex-1 items-center gap-2">
        {/* the repo yields first and drops out below @4xl — one truncating
            string would eat the MODEL's name (the one word nobody can guess
            from context) while spelling the repo out in full */}
        <span className="flex min-w-0 items-center text-sm">
          <Link
            to="/r/$owner/$repo"
            params={{ owner, repo: name }}
            search={{}}
            className="text-muted-foreground hover:text-foreground @max-4xl:hidden truncate transition-colors"
            title={`All models in ${repo}`}
          >
            {repo}
          </Link>
          <span className="text-muted-foreground/40 @max-4xl:hidden mx-1.5 shrink-0">/</span>
          {/* shrinks at a twentieth of the repo's rate: the repo gives up its
              characters first, the model name only once there is nothing left */}
          <span className="min-w-0 shrink-[.05] truncate font-medium">{title}</span>
          {subtitle ? (
            <span className="text-muted-foreground ml-1.5 min-w-0 shrink-[.05] truncate">{subtitle}</span>
          ) : null}
        </span>
        {notationLabel ? (
          <Badge variant="outline" className="shrink-0">
            {notationLabel}
          </Badge>
        ) : null}
        <ConnectionState status={status} />
        {modeActions.map((action) => (
          <ModeAction key={action.id} action={action} />
        ))}
      </div>

      <div className="flex shrink-0 items-center gap-2">
        {presence.length > 0 && (
          <>
            <div className="flex -space-x-1.5">
              {shownPeers.map((u, i) => (
                <PeerAvatar key={i} user={u} />
              ))}
              {hiddenPeers.length > 0 && (
                <div
                  className="border-background bg-muted text-muted-foreground flex size-6 items-center justify-center rounded-full border-2 text-[10px] font-semibold"
                  title={hiddenPeers.map((u) => u.name).join(", ")}
                >
                  +{hiddenPeers.length}
                </div>
              )}
            </div>
            <Divider />
          </>
        )}

        {view && <ViewSwitch {...view} />}

        {panels.length > 0 && (
          <div className="flex items-center gap-1">
            {panels.map((p) => {
              const open = activePanel === p.id;
              return (
                <Button
                  key={p.id}
                  variant="outline"
                  size="sm"
                  aria-pressed={open}
                  aria-label={p.label}
                  title={p.title}
                  onClick={() => onTogglePanel(p.id)}
                  className={cn(open && "border-primary/40 bg-primary/10 text-primary hover:bg-primary/15")}
                >
                  <p.icon />
                  <span className="@max-6xl:hidden">{p.label}</span>
                  {p.count ? <CountChip active={open}>{p.count}</CountChip> : null}
                </Button>
              );
            })}
          </div>
        )}

        {(addTodo || assist) && (
          <div className="flex items-center gap-1">
            {addTodo && (
              <Button
                variant="outline"
                size="sm"
                aria-label="Add todo"
                title={
                  addTodo.selectionCount > 0
                    ? `Anchor a todo to the ${addTodo.selectionCount} selected element${addTodo.selectionCount === 1 ? "" : "s"}`
                    : "Create a process-level todo (no element selected)"
                }
                onClick={addTodo.onAdd}
              >
                <ListPlus />
                <span className="@max-7xl:hidden">Add todo</span>
                {addTodo.selectionCount > 0 ? <CountChip>{addTodo.selectionCount}</CountChip> : null}
              </Button>
            )}
            {assist}
          </div>
        )}

        <Divider />
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="ghost" size="icon" className="size-8" aria-label="More" title="More">
              <Ellipsis />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            {menuPanels.map((p) => (
              <DropdownMenuCheckboxItem
                key={p.id}
                checked={activePanel === p.id}
                title={p.title}
                onSelect={() => onTogglePanel(p.id)}
              >
                <p.icon />
                {p.label}
                {p.count ? <CountChip>{p.count}</CountChip> : null}
              </DropdownMenuCheckboxItem>
            ))}
            <DropdownMenuSeparator />
            {/* inset: the icon lines up with the panel entries' icons above */}
            <DropdownMenuItem inset onSelect={onRelease}>
              <GitPullRequest />
              Release → PR
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
    </header>
  );
}

function Divider() {
  return <span className="bg-border h-5 w-px" aria-hidden="true" />;
}

function CountChip({ children, active = false }: { children: ReactNode; active?: boolean }) {
  return (
    <span
      className={cn(
        "rounded-sm px-1 text-[10px] font-semibold tabular-nums",
        active ? "bg-primary/15" : "bg-muted text-muted-foreground",
      )}
    >
      {children}
    </span>
  );
}

/** Sync state as a quiet status line, not a permanent green badge: the happy
 *  case is a dot + one word, the deviations get the words they need. Colour is
 *  never the only signal — every state keeps its label and its title. */
function ConnectionState({ status }: { status: EditorStatus }) {
  if (status === "connecting" || status === "slow") {
    return (
      <span className="text-muted-foreground flex shrink-0 items-center gap-1.5 text-xs" role="status">
        <Loader2 className="size-3 animate-spin" />
        {status === "slow" ? "Still connecting…" : "Connecting…"}
      </span>
    );
  }
  const live = status === "live";
  return (
    <span
      role="status"
      title={
        live ? "Live — every edit syncs to everyone in this document" : "Offline — this document is no longer syncing"
      }
      className={cn("flex shrink-0 items-center gap-1.5 text-xs", live ? "text-muted-foreground" : "text-destructive")}
    >
      <span className={cn("size-1.5 rounded-full", live ? "bg-success" : "bg-destructive")} aria-hidden="true" />
      {live ? "Live" : "Offline"}
    </span>
  );
}

function PeerAvatar({ user }: { user: PresenceUser }) {
  const avatar = safeAvatarUrl(user.avatarUrl);
  // color is peer input landing in inline CSS — same guard as the canvas/caret
  // render sites (url(...) would fetch on paint)
  const background = safePresenceColor(user.color);
  return avatar ? (
    <img
      className="border-background size-6 rounded-full border-2"
      src={avatar}
      alt={user.name}
      title={user.name}
      referrerPolicy="no-referrer"
      style={{ background }}
    />
  ) : (
    <div
      className="border-background flex size-6 items-center justify-center rounded-full border-2 text-[10px] font-semibold text-white"
      style={{ background }}
      title={user.name}
    >
      {user.name.slice(0, 2).toUpperCase()}
    </div>
  );
}

/** Diagram | Source. A segmented control states which view is CURRENT — the
 *  single "XML" button it replaces read the same in both. */
function ViewSwitch({
  sourceLabel,
  showSource,
  onChange,
}: {
  sourceLabel: string;
  showSource: boolean;
  onChange(showSource: boolean): void;
}) {
  const options = [
    { label: "Diagram", title: "Show the visual editor", icon: Shapes, active: !showSource, source: false },
    { label: sourceLabel, title: `Show the ${sourceLabel} source`, icon: Code, active: showSource, source: true },
  ];
  return (
    <div role="group" aria-label="Editor view" className="bg-muted flex h-8 items-center gap-0.5 rounded-md p-0.5">
      {options.map((o) => (
        <button
          key={o.label}
          type="button"
          aria-pressed={o.active}
          aria-label={o.label}
          title={o.title}
          onClick={() => onChange(o.source)}
          className={cn(
            "focus-visible:ring-ring/50 flex h-7 cursor-pointer items-center gap-1.5 rounded-sm px-2 text-xs font-medium transition-colors outline-none focus-visible:ring-[3px]",
            o.active ? "bg-background text-foreground shadow-xs" : "text-muted-foreground hover:text-foreground",
          )}
        >
          <o.icon className="size-3.5" />
          <span className="@max-4xl:hidden">{o.label}</span>
        </button>
      ))}
    </div>
  );
}

/** A document mode owned by the mounted editor ENGINE (MountedEditor.actions):
 *  the engine holds state and behavior, this only mirrors isActive(). The whole
 *  chip is the switch — the previous label sat OUTSIDE the control and clicking
 *  it did nothing — and it tints when on, because t.BPM changes the canvas for
 *  every participant. Actions without state render as a plain button. */
function ModeAction({ action }: { action: EditorToolbarAction }) {
  const [active, setActive] = useState(action.isActive?.() ?? false);
  useEffect(() => action.onChanged?.(() => setActive(action.isActive?.() ?? false)), [action]);
  if (!action.isActive) {
    return (
      <Button variant="outline" size="sm" className="shrink-0" title={action.buttonTitle} onClick={() => action.run()}>
        {action.label}
      </Button>
    );
  }
  return (
    <button
      type="button"
      role="switch"
      aria-checked={active}
      title={action.buttonTitle}
      onClick={() => action.run()}
      className={cn(
        "focus-visible:ring-ring/50 flex h-8 shrink-0 cursor-pointer items-center gap-2 rounded-md border px-2.5 text-xs font-medium transition-colors outline-none focus-visible:ring-[3px]",
        active
          ? "border-primary/40 bg-primary/10 text-primary"
          : "border-input bg-background text-muted-foreground hover:text-foreground",
      )}
    >
      <span
        aria-hidden="true"
        className={cn("relative h-3.5 w-6 rounded-full transition-colors", active ? "bg-primary" : "bg-input")}
      >
        {/* left-0.5 is load-bearing: a <button> carries the UA's
            text-align:center, which the track inherits, and Blink resolves an
            absolute child's static position from it — the knob started 12px in
            and slid out of the track onto the label. Pin it, then travel the
            10px the track actually has (24 − 2·2 − 10). */}
        <span
          className={cn(
            "bg-background absolute top-0.5 left-0.5 size-2.5 rounded-full shadow-xs transition-transform",
            active ? "translate-x-2.5" : "translate-x-0",
          )}
        />
      </span>
      {action.label}
    </button>
  );
}
