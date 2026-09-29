import { byId } from "@bpmiq/notations";
import { type NotationDescriptor, NOTATIONS } from "@bpmiq/notations";
import { hasTemplate } from "@bpmiq/notations/templates";
import { Badge } from "@bpmiq/ui-kit/components/badge";
import { Button } from "@bpmiq/ui-kit/components/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@bpmiq/ui-kit/components/dropdown-menu";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@bpmiq/ui-kit/components/table";
import { cn } from "@bpmiq/ui-kit/lib/utils";
import { getRouteApi, Link, useNavigate } from "@tanstack/react-router";
import {
  type Column,
  type ColumnDef,
  createSortedRowModel,
  flexRender,
  rowSortingFeature,
  sortFn_alphanumeric,
  sortFn_text,
  type SortingState,
  tableFeatures,
  useTable,
} from "@tanstack/react-table";
import {
  ArrowDownToLine,
  ArrowLeft,
  ArrowUpDown,
  ArrowUpToLine,
  Boxes,
  ChartNetwork,
  ChevronDown,
  ChevronUp,
  Copy,
  Ellipsis,
  FileText,
  Folder,
  FolderInput,
  FolderPlus,
  Pencil,
  Plus,
  Shapes,
  StickyNote,
  Table2,
  Trash2,
  Users,
  Workflow,
} from "lucide-react";
import {
  type ComponentType,
  type DragEvent,
  type MouseEvent,
  type ReactNode,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { toast } from "sonner";

import { AssistMenu } from "@/components/assist-menu";
import { CreateDecisionDialog } from "@/components/create-decision-dialog";
import { CreateFolderDialog } from "@/components/create-folder-dialog";
import { CreateNotationModelDialog } from "@/components/create-notation-model-dialog";
import { CreateProcessDialog } from "@/components/create-process-dialog";
import { DeleteModelsDialog } from "@/components/delete-models-dialog";
import { DuplicateModelDialog } from "@/components/duplicate-model-dialog";
import { type MovableModel, MoveModelDialog } from "@/components/move-model-dialog";
import { ReleaseDialog } from "@/components/release-dialog";
import { RenameModelDialog } from "@/components/rename-model-dialog";
import { SyncRepoDialog } from "@/components/sync-repo-dialog";
import { type ProcessInfo } from "@/lib/api";
import { type ModelTarget, modelTarget, useOpenModel } from "@/lib/model-target";
import { useDecisions, useFolders, useModels, useMoveModels, useProcesses, useRepos, useSyncRepo } from "@/lib/queries";
import { webPlugin } from "@/notations/registry";

const route = getRouteApi("/r/$owner/$repo");

/** notations the "New" menu offers GENERICALLY (#139): everything with a
 *  blank template except bpmn/dmn, which keep their typed flows above */
const CREATABLE_NOTATIONS = NOTATIONS.filter((n) => hasTemplate(n.id) && n.id !== "bpmn" && n.id !== "dmn");

/** each notation's icon — one a user can GUESS from the label — shown in the
 *  "New" menu AND on the model rows of the listing, so a file reads the same
 *  where it is created and where it is found. A notation without an entry
 *  falls back to the neutral Shapes, so a new registry entry never ships
 *  icon-less */
const NOTATION_ICONS = new Map<string, ComponentType<{ className?: string }>>([
  ["wardley", ChartNetwork],
  ["team-topology", Users],
  ["event-storming", StickyNote],
  ["context-map", Boxes],
  ["markdown", FileText],
]);

/**
 * The table features this route opts into — v9 ships nothing but the core, so
 * anything beyond plain rows is registered here. Sorting only: the process
 * table sorts client-side over one page of rows. The two sort fns are the ones
 * `sortFn: "auto"` resolves to for our columns (strings — names and file
 * paths); numeric columns fall back to the built-in basic comparator, which
 * needs no registration.
 */
const features = tableFeatures({
  rowSortingFeature,
  sortedRowModel: createSortedRowModel(),
  sortFns: { alphanumeric: sortFn_alphanumeric, text: sortFn_text },
});

/** one sub-folder row of the current directory, with aggregated child stats */
interface FolderRow {
  name: string;
  /** processes-root-relative path */
  path: string;
  /** processes + decisions inside (recursive) */
  modelCount: number;
  dirty: boolean;
}

/** parent folder of a processes-root-relative path ("" = root) */
const parentOf = (path: string): string => (path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "");

/** DOM id of a folder row — the just-created one is scrolled into view */
const folderRowId = (path: string): string => `folder-row:${path}`;

/** DOM id of a model row — a duplicated or renamed one is scrolled into view */
const modelRowId = (path: string): string => `model-row:${path}`;

/** the drag payload of a model row (#182) — folder rows and the breadcrumb take it.
 *  A row that is part of the selection drags the whole selection (#210). It
 *  names its repo: a row dragged in from ANOTHER repo's window must not move
 *  whatever sits at the same path here */
const DRAG_TYPE = "application/x-bpmiq-model";
type DragPayload = { repo: string; models: MovableModel[] };

/** one model row of the current level, whatever its kind — the unit the
 *  selection, the row menu and the dialogs work on */
interface VisibleModel {
  path: string;
  target: ModelTarget;
  movable: MovableModel;
}

/** what a move needs of any model row (process rows carry their path as `bpmn`) */
const movable = (m: { name: string; folder: string; liveSessions: number }, path: string): MovableModel => ({
  path,
  name: m.name,
  folder: m.folder,
  liveSessions: m.liveSessions,
});

export function ProcessList() {
  const { owner, repo: name } = route.useParams();
  const { dir = "" } = route.useSearch();
  const repo = `${owner}/${name}`;
  const navigate = useNavigate();
  const processes = useProcesses(repo);
  const list = useMemo(() => processes.data ?? [], [processes.data]);
  const decisionsQuery = useDecisions(repo);
  const decisions = useMemo(() => decisionsQuery.data ?? [], [decisionsQuery.data]);
  // model files beyond .bpmn/.dmn (wardley, team-topology, …) — those two
  // already render as the typed process/decision rows above
  const modelsQuery = useModels(repo);
  const otherModels = useMemo(
    () => (modelsQuery.data ?? []).filter((m) => m.notation !== "bpmn" && m.notation !== "dmn"),
    [modelsQuery.data],
  );
  const folders = useFolders(repo);
  // a content repo declares itself with a root bpmiq.yml; without one, creating
  // folders/processes 422s and a release has nothing to ship — so the view hides
  // those actions. Assume yes until the (cloning) folders query proves otherwise,
  // so the actions don't flicker for the overwhelmingly common content repo.
  const isContentRepo = folders.data?.isContentRepo ?? true;
  const repos = useRepos();
  const branch = repos.data?.find((r) => r.fullName === repo)?.defaultBranch ?? "main";
  const sync = useSyncRepo(repo);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [folderOpen, setFolderOpen] = useState(false);
  const [processOpen, setProcessOpen] = useState(false);
  const [decisionOpen, setDecisionOpen] = useState(false);
  const [modelNotation, setModelNotation] = useState<NotationDescriptor | null>(null);
  const [releaseOpen, setReleaseOpen] = useState(false);
  // a created folder stays a row on THIS level (#181) — marked for a moment so
  // the eye finds it; the toast's Open action is the way in
  const [createdFolder, setCreatedFolder] = useState<string | null>(null);
  useEffect(() => {
    if (!createdFolder) return;
    document.getElementById(folderRowId(createdFolder))?.scrollIntoView({ block: "nearest" });
    const timer = setTimeout(() => setCreatedFolder(null), 2500);
    return () => clearTimeout(timer);
  }, [createdFolder]);
  // moving models (#182): the "Move to…" dialog, and drag & drop of a model
  // row onto a folder row or a breadcrumb segment
  const [moving, setMoving] = useState<MovableModel[] | null>(null);
  const [dropTarget, setDropTarget] = useState<string | null>(null);
  const move = useMoveModels(repo);
  // the row actions (#208–#210): one dialog at a time
  const [renaming, setRenaming] = useState<ModelTarget | null>(null);
  const [duplicating, setDuplicating] = useState<ModelTarget | null>(null);
  const [deleting, setDeleting] = useState<ModelTarget[] | null>(null);
  const openModel = useOpenModel(repo);
  // a duplicated or renamed model's row is marked for a moment (#181's idiom)
  const [highlighted, setHighlighted] = useState<string | null>(null);
  useEffect(() => {
    if (!highlighted) return;
    document.getElementById(modelRowId(highlighted))?.scrollIntoView({ block: "nearest" });
    const timer = setTimeout(() => setHighlighted(null), 2500);
    return () => clearTimeout(timer);
  }, [highlighted]);
  // multi-select (#210): selected model paths of THIS level; shift-click
  // extends from the last toggled row
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());
  const anchorRef = useRef<string | null>(null);
  useEffect(() => {
    setSelected(new Set());
    anchorRef.current = null;
  }, [dir]);

  // models (processes AND decisions) with unreleased live edits the reset
  // would discard, and repos being actively edited (Variant A: a reset can't
  // safely race an open session). Decisions used to be discarded UNLISTED —
  // the confirmation named only processes while the reset dropped both.
  // keyed by PATH: names may collide across kinds (order.bpmn + order.dmn are
  // legal separate namespaces), paths are unique repo-wide
  const dirtyModels = [
    ...list.filter((p) => p.dirty).map((p) => ({ path: p.bpmn, name: p.name })),
    ...decisions.filter((d) => d.dirty).map((d) => ({ path: d.path, name: d.name })),
    ...otherModels.filter((m) => m.dirty).map((m) => ({ path: m.path, name: m.name })),
  ];
  const activeSessions = [...list, ...decisions, ...otherModels].reduce((n, m) => n + m.liveSessions, 0);

  // the folder tree: disk folders (includes empty ones) ∪ ancestors of every
  // process/decision path — so rows render even while the folders query is
  // still loading
  const folderSet = useMemo(() => {
    const set = new Set<string>(folders.data?.folders ?? []);
    for (const m of [...list, ...decisions, ...otherModels]) {
      for (let f = m.folder; f !== ""; f = parentOf(f)) set.add(f);
    }
    return set;
  }, [folders.data, list, decisions, otherModels]);

  const childFolders = useMemo<FolderRow[]>(
    () =>
      [...folderSet]
        .filter((f) => parentOf(f) === dir)
        .sort()
        .map((path) => {
          const inside = [...list, ...decisions, ...otherModels].filter(
            (m) => m.folder === path || m.folder.startsWith(`${path}/`),
          );
          return {
            name: path.split("/").pop() ?? path,
            path,
            modelCount: inside.length,
            dirty: inside.some((m) => m.dirty),
          };
        }),
    [folderSet, list, decisions, otherModels, dir],
  );

  const allFolders = useMemo(() => [...folderSet].sort(), [folderSet]);

  // the view stays on this level; the toast leads to the models' new home
  const announceMove = (models: MovableModel[], folder: string) => {
    const what = models.length === 1 ? `'${models[0]?.name}'` : `${models.length} models`;
    toast.success(`Moved ${what} to ${folder ? `${folder}/` : "the root"}`, {
      action: {
        label: "Open folder",
        onClick: () => void navigate({ to: "/r/$owner/$repo", params: { owner, repo: name }, search: { dir: folder } }),
      },
    });
  };
  const dragModel = (e: DragEvent, model: MovableModel) => {
    // a selected row carries the whole selection along
    const models = selected.has(model.path)
      ? visibleModels.filter((m) => selected.has(m.path)).map((m) => m.movable)
      : [model];
    e.dataTransfer.setData(DRAG_TYPE, JSON.stringify({ repo, models } satisfies DragPayload));
    e.dataTransfer.effectAllowed = "move";
  };
  const dropInto = (folder: string) => ({
    onDragOver: (e: DragEvent) => {
      if (!e.dataTransfer.types.includes(DRAG_TYPE)) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = "move";
      setDropTarget(folder);
    },
    onDragLeave: () => setDropTarget((t) => (t === folder ? null : t)),
    onDrop: (e: DragEvent) => {
      const raw = e.dataTransfer.getData(DRAG_TYPE);
      setDropTarget(null);
      if (!raw) return;
      e.preventDefault();
      const payload = JSON.parse(raw) as DragPayload;
      const models = (payload.models ?? []).filter((m) => m.folder !== folder);
      if (payload.repo !== repo || models.length === 0) return;
      move.mutate(
        { paths: models.map((m) => m.path), folder },
        {
          onSuccess: () => {
            setSelected(new Set());
            announceMove(models, folder);
          },
          onError: (err) => toast.error(err.message),
        },
      );
    },
  });

  const visible = useMemo(() => list.filter((p) => p.folder === dir), [list, dir]);
  const visibleDecisions = useMemo(
    () => decisions.filter((d) => d.folder === dir).sort((a, b) => a.name.localeCompare(b.name)),
    [decisions, dir],
  );
  const visibleOthers = useMemo(
    () => otherModels.filter((m) => m.folder === dir).sort((a, b) => a.name.localeCompare(b.name)),
    [otherModels, dir],
  );
  const segments = dir === "" ? [] : dir.split("/");

  const runSync = () =>
    sync.mutate(undefined, {
      onSuccess: (result) => {
        setConfirmOpen(false);
        toast.success(
          result.changed.length === 0
            ? `Already up to date with ${result.branch}`
            : `Loaded latest from ${result.branch} — ${result.changed.length} file${result.changed.length === 1 ? "" : "s"} updated`,
        );
      },
      // the dialog shows sync.error inline; the clean (no-dialog) path needs a toast
      onError: (e) => {
        if (!confirmOpen) toast.error(e.message);
      },
    });

  const onLoadLatest = () => {
    if (dirtyModels.length > 0) setConfirmOpen(true);
    else runSync();
  };

  const [sorting, setSorting] = useState<SortingState>([{ id: "name", desc: false }]);

  const columns = useMemo<ColumnDef<typeof features, ProcessInfo>[]>(
    () => [
      {
        accessorKey: "name",
        header: ({ column }) => <SortHeader column={column}>Process</SortHeader>,
        cell: ({ row }) => (
          <Link
            to="/r/$owner/$repo/p/$processId"
            params={{ owner, repo: name, processId: row.original.id }}
            className="font-medium hover:underline"
            onClick={(e) => e.stopPropagation()}
          >
            {row.original.name}
          </Link>
        ),
      },
      {
        accessorKey: "bpmn",
        header: ({ column }) => <SortHeader column={column}>File</SortHeader>,
        cell: ({ getValue }) => <span className="text-muted-foreground font-mono text-xs">{getValue<string>()}</span>,
      },
      {
        id: "models",
        header: "Models",
        enableSorting: false,
        cell: ({ row }) =>
          row.original.models.length === 0 ? (
            <span className="text-muted-foreground">—</span>
          ) : (
            <div className="flex flex-wrap gap-1.5">
              {row.original.models.map((m) => (
                <Link
                  key={m.path}
                  to="/r/$owner/$repo/f/$"
                  params={{ owner, repo: name, _splat: m.path }}
                  title={m.path}
                  onClick={(e) => e.stopPropagation()}
                >
                  <Badge variant="outline" className="hover:bg-accent">
                    {m.notation}: {m.path.split("/").pop()}
                  </Badge>
                </Link>
              ))}
            </div>
          ),
      },
      {
        id: "status",
        header: "Status",
        accessorFn: (p) => (p.dirty ? 1 : 0) + (p.liveSessions > 0 ? 1 : 0),
        cell: ({ row }) => {
          const p = row.original;
          if (!p.dirty && p.liveSessions === 0) return <span className="text-muted-foreground">—</span>;
          return (
            <div className="flex flex-wrap gap-1.5">
              {p.dirty && <Badge variant="warning">live changes</Badge>}
              {p.liveSessions > 0 && <Badge>{p.liveSessions} active</Badge>}
            </div>
          );
        },
      },
      {
        id: "analyse",
        header: "",
        enableSorting: false,
        cell: ({ row }) => (
          <div className="flex items-center gap-0.5">
            <AssistMenu repo={`${owner}/${name}`} path={row.original.bpmn} notation="bpmn" variant="row" />
            <ModelRowMenu actions={rowActionsRef.current(row.original.bpmn)} />
          </div>
        ),
      },
    ],
    [owner, name],
  );

  const table = useTable({
    features,
    data: visible,
    columns,
    state: { sorting },
    onSortingChange: setSorting,
  });

  // every model row of this level in DISPLAY order (the sorted process table,
  // then decisions, then the other notations) — shift-click ranges over it
  const processRows = table.getRowModel().rows;
  const visibleModels: VisibleModel[] = [
    ...processRows.map((r) => r.original).map((p) => ({ path: p.bpmn, row: p })),
    ...visibleDecisions.map((d) => ({ path: d.path, row: d })),
    ...visibleOthers.map((m) => ({ path: m.path, row: m })),
  ].map(({ path, row }) => ({ path, target: modelTarget(path, row), movable: movable(row, path) }));
  const byPath = new Map(visibleModels.map((m) => [m.path, m]));
  const selectedModels = visibleModels.filter((m) => selected.has(m.path));

  const toggle = (path: string, range: boolean) => {
    const order = visibleModels.map((m) => m.path);
    const anchor = anchorRef.current;
    setSelected((prev) => {
      const next = new Set(prev);
      // a range takes the state the clicked row gets (Gmail's rule)
      const on = !prev.has(path);
      const here = order.indexOf(path);
      const there = range && anchor ? order.indexOf(anchor) : -1;
      const [from, to] = there === -1 ? [here, here] : [Math.min(here, there), Math.max(here, there)];
      for (const p of order.slice(from, to + 1)) {
        if (on) next.add(p);
        else next.delete(p);
      }
      return next;
    });
    anchorRef.current = path;
  };
  const allSelected = visibleModels.length > 0 && selectedModels.length === visibleModels.length;
  const toggleAll = () => setSelected(allSelected ? new Set() : new Set(visibleModels.map((m) => m.path)));
  // Escape drops the selection — unless a dialog is open (it closes first)
  const dialogOpen = Boolean(renaming || duplicating || deleting || moving);
  useEffect(() => {
    if (selected.size === 0 || dialogOpen) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") setSelected(new Set());
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [selected.size, dialogOpen]);

  // the row ⋯ menu's actions for a model path; read through a ref so the
  // memoized process columns always reach the CURRENT rows and setters
  const rowActions = (path: string): RowActions => {
    const m = byPath.get(path);
    return {
      onRename: () => m && setRenaming(m.target),
      onDuplicate: () => m && setDuplicating(m.target),
      onMove: () => m && setMoving([m.movable]),
      onDelete: () => m && setDeleting([m.target]),
    };
  };
  const rowActionsRef = useRef(rowActions);
  rowActionsRef.current = rowActions;
  // ids already taken per notation — a duplicate's suggested name avoids them
  const takenIds = (notation: string): Set<string> =>
    new Set(
      notation === "bpmn"
        ? list.map((p) => p.id)
        : notation === "dmn"
          ? decisions.map((d) => d.id)
          : otherModels.filter((m) => m.notation === notation).map((m) => m.id),
    );

  /** the leading selection cell of a model row — the whole cell is the hit
   *  area; labelled by FILE name (order.bpmn and order.storm share a name) */
  const selectCell = (path: string) => (
    <TableCell
      className="w-8 cursor-default pr-0"
      onClick={(e) => {
        e.stopPropagation();
        toggle(path, e.shiftKey);
      }}
    >
      <SelectBox
        checked={selected.has(path)}
        label={`Select ${path.split("/").pop() ?? path}`}
        onToggle={(shift) => toggle(path, shift)}
      />
    </TableCell>
  );

  const empty =
    childFolders.length === 0 && visible.length === 0 && visibleDecisions.length === 0 && visibleOthers.length === 0;

  return (
    <div className="mx-auto w-full max-w-5xl px-6 py-8">
      <Button asChild variant="ghost" size="sm" className="mb-2 -ml-2">
        <Link to="/">
          <ArrowLeft /> Repositories
        </Link>
      </Button>
      <div className="flex items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">{repo}</h1>
          <p className="text-muted-foreground mb-6 text-sm">
            Model live — every release becomes a reviewable pull request.
          </p>
        </div>
        <div className="flex shrink-0 flex-wrap justify-end gap-2">
          {(list.length > 0 || decisions.length > 0) && (
            <Button
              variant="outline"
              size="sm"
              onClick={onLoadLatest}
              disabled={sync.isPending || activeSessions > 0}
              title={
                activeSessions > 0
                  ? `Close the ${activeSessions} active editing session${activeSessions === 1 ? "" : "s"} first`
                  : `Reset this repository to the latest ${branch}`
              }
            >
              <ArrowDownToLine />
              {sync.isPending ? "Loading…" : `Load latest from ${branch}`}
            </Button>
          )}
          {/* create/release only make sense in a content repo (a root bpmiq.yml).
              Without one, a create 422s and a release has nothing to ship — so
              the actions are hidden and the body explains it's not a BPM repo. */}
          {isContentRepo && (
            <>
              <Button variant="outline" size="sm" onClick={() => setReleaseOpen(true)}>
                <ArrowUpToLine /> Release
              </Button>
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button size="sm">
                    <Plus /> New
                  </Button>
                </DropdownMenuTrigger>
                {/* the menu items open DIALOGS — mount them a tick AFTER radix
                    finished its close/focus handling (and suppress the trigger
                    refocus), or the name field's autoFocus is stolen */}
                <DropdownMenuContent align="end" onCloseAutoFocus={(e) => e.preventDefault()}>
                  <DropdownMenuItem onSelect={() => setTimeout(() => setFolderOpen(true), 0)}>
                    <FolderPlus /> Folder
                  </DropdownMenuItem>
                  <DropdownMenuItem onSelect={() => setTimeout(() => setProcessOpen(true), 0)}>
                    <Workflow /> BPMN process
                  </DropdownMenuItem>
                  <DropdownMenuItem onSelect={() => setTimeout(() => setDecisionOpen(true), 0)}>
                    <Table2 /> DMN decision
                  </DropdownMenuItem>
                  {CREATABLE_NOTATIONS.map((n) => {
                    const Icon = NOTATION_ICONS.get(n.id) ?? Shapes;
                    return (
                      <DropdownMenuItem key={n.id} onSelect={() => setTimeout(() => setModelNotation(n), 0)}>
                        <Icon /> {n.label}
                      </DropdownMenuItem>
                    );
                  })}
                </DropdownMenuContent>
              </DropdownMenu>
            </>
          )}
        </div>
      </div>

      {segments.length > 0 && (
        <nav className="mb-3 flex flex-wrap items-center gap-1 text-sm" aria-label="Folder">
          <Link
            to="/r/$owner/$repo"
            params={{ owner, repo: name }}
            className={cn("text-muted-foreground rounded px-1 hover:underline", dropTarget === "" && "bg-primary/10")}
            {...dropInto("")}
          >
            {name}
          </Link>
          {segments.map((segment, i) => {
            const path = segments.slice(0, i + 1).join("/");
            const last = i === segments.length - 1;
            return (
              <span key={path} className="flex items-center gap-1">
                <span className="text-muted-foreground">/</span>
                {last ? (
                  <span className="font-medium">{segment}</span>
                ) : (
                  <Link
                    to="/r/$owner/$repo"
                    params={{ owner, repo: name }}
                    search={{ dir: path }}
                    className={cn(
                      "text-muted-foreground rounded px-1 hover:underline",
                      dropTarget === path && "bg-primary/10",
                    )}
                    {...dropInto(path)}
                  >
                    {segment}
                  </Link>
                )}
              </span>
            );
          })}
        </nav>
      )}

      {processes.isLoading ? (
        <p className="text-muted-foreground text-sm">Loading… (the first load clones the repository)</p>
      ) : !isContentRepo ? (
        <p className="text-muted-foreground max-w-prose text-sm">
          Not a BPM repository — this repo has no <code className="bg-muted rounded px-1">bpmiq.yml</code> at its root
          naming the folder its models live in (e.g. <code className="bg-muted rounded px-1">processes: processes</code>
          ). Add one to create folders, processes and releases here.
        </p>
      ) : empty && dir !== "" ? (
        <p className="text-muted-foreground max-w-prose text-sm">
          This folder is empty — create a process or folder here, or head back to the{" "}
          <Link to="/r/$owner/$repo" params={{ owner, repo: name }} className="underline">
            repository root
          </Link>
          .
        </p>
      ) : empty ? (
        <p className="text-muted-foreground max-w-prose text-sm">
          No models yet — create a process, decision or folder with the <span className="font-medium">New</span> button.
        </p>
      ) : (
        <div className="rounded-xl border">
          <Table>
            <TableHeader>
              {table.getHeaderGroups().map((hg) => (
                <TableRow key={hg.id} className="hover:bg-transparent">
                  <TableHead className="w-8 pr-0">
                    {visibleModels.length > 0 && (
                      <SelectBox
                        checked={allSelected}
                        indeterminate={selectedModels.length > 0 && !allSelected}
                        label={allSelected ? "Clear the selection" : "Select every model in this folder"}
                        onToggle={toggleAll}
                      />
                    )}
                  </TableHead>
                  {hg.headers.map((header) => (
                    <TableHead key={header.id}>
                      {header.isPlaceholder ? null : flexRender(header.column.columnDef.header, header.getContext())}
                    </TableHead>
                  ))}
                </TableRow>
              ))}
            </TableHeader>
            <TableBody>
              {childFolders.map((f) => (
                <TableRow
                  key={`folder:${f.path}`}
                  id={folderRowId(f.path)}
                  className={cn(
                    "cursor-pointer transition-colors duration-700",
                    (f.path === createdFolder || f.path === dropTarget) && "bg-primary/10",
                  )}
                  {...dropInto(f.path)}
                  onClick={() =>
                    navigate({ to: "/r/$owner/$repo", params: { owner, repo: name }, search: { dir: f.path } })
                  }
                >
                  <TableCell className="w-8 pr-0" />
                  <TableCell>
                    <Link
                      to="/r/$owner/$repo"
                      params={{ owner, repo: name }}
                      search={{ dir: f.path }}
                      className="flex items-center gap-2 font-medium hover:underline"
                      onClick={(e) => e.stopPropagation()}
                    >
                      <Folder className="text-muted-foreground size-4" />
                      {f.name}
                    </Link>
                  </TableCell>
                  <TableCell>
                    <span className="text-muted-foreground font-mono text-xs">{f.path}/</span>
                  </TableCell>
                  <TableCell>
                    <span className="text-muted-foreground">
                      {f.modelCount === 0 ? "empty" : `${f.modelCount} model${f.modelCount === 1 ? "" : "s"}`}
                    </span>
                  </TableCell>
                  <TableCell>
                    {f.dirty ? (
                      <Badge variant="warning">live changes</Badge>
                    ) : (
                      <span className="text-muted-foreground">—</span>
                    )}
                  </TableCell>
                  <TableCell />
                </TableRow>
              ))}
              {processRows.map((row) => (
                <TableRow
                  key={row.id}
                  id={modelRowId(row.original.bpmn)}
                  className={cn(
                    "cursor-pointer transition-colors duration-700",
                    highlighted === row.original.bpmn && "bg-primary/10",
                  )}
                  data-state={selected.has(row.original.bpmn) ? "selected" : undefined}
                  draggable
                  onDragStart={(e) => dragModel(e, movable(row.original, row.original.bpmn))}
                  onDragEnd={() => setDropTarget(null)}
                  onClick={() =>
                    navigate({
                      to: "/r/$owner/$repo/p/$processId",
                      params: { owner, repo: name, processId: row.original.id },
                    })
                  }
                >
                  {selectCell(row.original.bpmn)}
                  {row.getAllCells().map((cell) => (
                    <TableCell key={cell.id}>{flexRender(cell.column.columnDef.cell, cell.getContext())}</TableCell>
                  ))}
                </TableRow>
              ))}
              {visibleDecisions.map((d) => (
                <TableRow
                  key={`decision:${d.path}`}
                  id={modelRowId(d.path)}
                  className={cn(
                    "cursor-pointer transition-colors duration-700",
                    highlighted === d.path && "bg-primary/10",
                  )}
                  data-state={selected.has(d.path) ? "selected" : undefined}
                  draggable
                  onDragStart={(e) => dragModel(e, movable(d, d.path))}
                  onDragEnd={() => setDropTarget(null)}
                  onClick={() => navigate({ to: "/r/$owner/$repo/f/$", params: { owner, repo: name, _splat: d.path } })}
                >
                  {selectCell(d.path)}
                  <TableCell>
                    <Link
                      to="/r/$owner/$repo/f/$"
                      params={{ owner, repo: name, _splat: d.path }}
                      className="flex items-center gap-2 font-medium hover:underline"
                      onClick={(e) => e.stopPropagation()}
                    >
                      <Table2 className="text-muted-foreground size-4" />
                      {d.name}
                    </Link>
                  </TableCell>
                  <TableCell>
                    <span className="text-muted-foreground font-mono text-xs">{d.path}</span>
                  </TableCell>
                  <TableCell>
                    <Badge variant="outline">DMN</Badge>
                  </TableCell>
                  <TableCell>
                    {!d.dirty && d.liveSessions === 0 ? (
                      <span className="text-muted-foreground">—</span>
                    ) : (
                      <div className="flex flex-wrap gap-1.5">
                        {d.dirty && <Badge variant="warning">live changes</Badge>}
                        {d.liveSessions > 0 && <Badge>{d.liveSessions} active</Badge>}
                      </div>
                    )}
                  </TableCell>
                  <TableCell>
                    <div className="flex items-center gap-0.5">
                      <AssistMenu repo={repo} path={d.path} notation="dmn" variant="row" />
                      <ModelRowMenu actions={rowActions(d.path)} />
                    </div>
                  </TableCell>
                </TableRow>
              ))}
              {visibleOthers.map((m) => {
                // the same icon the "New" menu showed for this notation
                const Icon = NOTATION_ICONS.get(m.notation) ?? Shapes;
                // the same gate as the editor toolbar: a notation without a
                // widget never offers the handoff
                const assistNotation = webPlugin(m.notation)?.assistNotation;
                return (
                  <TableRow
                    key={`model:${m.path}`}
                    id={modelRowId(m.path)}
                    className={cn(
                      "cursor-pointer transition-colors duration-700",
                      highlighted === m.path && "bg-primary/10",
                    )}
                    data-state={selected.has(m.path) ? "selected" : undefined}
                    draggable
                    onDragStart={(e) => dragModel(e, movable(m, m.path))}
                    onDragEnd={() => setDropTarget(null)}
                    onClick={() =>
                      navigate({ to: "/r/$owner/$repo/f/$", params: { owner, repo: name, _splat: m.path } })
                    }
                  >
                    {selectCell(m.path)}
                    <TableCell>
                      <Link
                        to="/r/$owner/$repo/f/$"
                        params={{ owner, repo: name, _splat: m.path }}
                        className="flex items-center gap-2 font-medium hover:underline"
                        onClick={(e) => e.stopPropagation()}
                      >
                        <Icon className="text-muted-foreground size-4" />
                        {m.name}
                      </Link>
                    </TableCell>
                    <TableCell>
                      <span className="text-muted-foreground font-mono text-xs">{m.path}</span>
                    </TableCell>
                    <TableCell>
                      <Badge variant="outline">{byId(m.notation)?.label ?? m.notation}</Badge>
                    </TableCell>
                    <TableCell>
                      {!m.dirty && m.liveSessions === 0 ? (
                        <span className="text-muted-foreground">—</span>
                      ) : (
                        <div className="flex flex-wrap gap-1.5">
                          {m.dirty && <Badge variant="warning">live changes</Badge>}
                          {m.liveSessions > 0 && <Badge>{m.liveSessions} active</Badge>}
                        </div>
                      )}
                    </TableCell>
                    <TableCell>
                      <div className="flex items-center gap-0.5">
                        {assistNotation && (
                          <AssistMenu repo={repo} path={m.path} notation={assistNotation} variant="row" />
                        )}
                        <ModelRowMenu actions={rowActions(m.path)} />
                      </div>
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        </div>
      )}

      {confirmOpen && (
        <SyncRepoDialog
          branch={branch}
          dirtyModels={dirtyModels}
          pending={sync.isPending}
          error={sync.error}
          onConfirm={runSync}
          onClose={() => setConfirmOpen(false)}
        />
      )}
      {folderOpen && (
        <CreateFolderDialog
          repo={repo}
          parent={dir}
          onClose={() => setFolderOpen(false)}
          onCreated={(path) => {
            setFolderOpen(false);
            setCreatedFolder(path);
            toast.success(`Folder '${path}' created`, {
              action: {
                label: "Open",
                onClick: () =>
                  void navigate({ to: "/r/$owner/$repo", params: { owner, repo: name }, search: { dir: path } }),
              },
            });
          }}
        />
      )}
      {processOpen && (
        <CreateProcessDialog
          repo={repo}
          folder={dir}
          onClose={() => setProcessOpen(false)}
          onCreated={(created) => {
            setProcessOpen(false);
            toast.success(`Process '${created.id}' created`, {
              description: "Release it as a pull request when the model is ready.",
            });
            void navigate({
              to: "/r/$owner/$repo/p/$processId",
              params: { owner, repo: name, processId: created.id },
            });
          }}
        />
      )}
      {decisionOpen && (
        <CreateDecisionDialog
          repo={repo}
          folder={dir}
          onClose={() => setDecisionOpen(false)}
          onCreated={(created) => {
            setDecisionOpen(false);
            toast.success(`Decision '${created.id}' created`);
            void navigate({ to: "/r/$owner/$repo/f/$", params: { owner, repo: name, _splat: created.path } });
          }}
        />
      )}
      {modelNotation && (
        <CreateNotationModelDialog
          repo={repo}
          notation={modelNotation}
          folder={dir}
          onClose={() => setModelNotation(null)}
          onCreated={(created) => {
            const label = modelNotation.label;
            setModelNotation(null);
            toast.success(`${label} '${created.id}' created`, {
              description: "Release it as a pull request when the model is ready.",
            });
            void navigate({ to: "/r/$owner/$repo/f/$", params: { owner, repo: name, _splat: created.path } });
          }}
        />
      )}
      {releaseOpen && <ReleaseDialog repo={repo} onClose={() => setReleaseOpen(false)} />}
      {moving && (
        <MoveModelDialog
          repo={repo}
          models={moving}
          folders={allFolders}
          onClose={() => setMoving(null)}
          onMoved={(folder) => {
            setMoving(null);
            setSelected(new Set());
            announceMove(moving, folder);
          }}
        />
      )}
      {renaming && (
        <RenameModelDialog
          repo={repo}
          model={renaming}
          onClose={() => setRenaming(null)}
          onRenamed={(result) => {
            setRenaming(null);
            setSelected((prev) => new Set([...prev].filter((p) => p !== renaming.path)));
            setHighlighted(result.path);
          }}
        />
      )}
      {duplicating && (
        <DuplicateModelDialog
          repo={repo}
          model={duplicating}
          takenIds={takenIds(duplicating.notation)}
          onClose={() => setDuplicating(null)}
          onDuplicated={({ model }) => {
            setDuplicating(null);
            setHighlighted(model.path);
            toast.success(`Duplicated as '${model.id}'`, {
              action: { label: "Open", onClick: () => void openModel(model.path) },
            });
          }}
        />
      )}
      {deleting && (
        <DeleteModelsDialog
          repo={repo}
          models={deleting}
          onClose={() => setDeleting(null)}
          onDeleted={() => {
            const gone = deleting;
            setDeleting(null);
            setSelected(new Set());
            toast.success(gone.length === 1 ? `Deleted '${gone[0]?.id}'` : `Deleted ${gone.length} models`, {
              description: "The deletion ships with your next release.",
            });
          }}
        />
      )}
      {selectedModels.length > 0 && !dialogOpen && (
        <SelectionBar
          count={selectedModels.length}
          onMove={() => setMoving(selectedModels.map((m) => m.movable))}
          onDelete={() => setDeleting(selectedModels.map((m) => m.target))}
          onClear={() => setSelected(new Set())}
        />
      )}
    </div>
  );
}

/** the bulk action bar (#210) — floats over the list while models are
 *  selected: "N selected · Move to… · Delete… · Clear" */
function SelectionBar({
  count,
  onMove,
  onDelete,
  onClear,
}: {
  count: number;
  onMove: () => void;
  onDelete: () => void;
  onClear: () => void;
}) {
  return (
    <div
      role="toolbar"
      aria-label="Selected models"
      className="bg-background animate-in fade-in slide-in-from-bottom-2 fixed bottom-6 left-1/2 z-40 flex -translate-x-1/2 items-center gap-1 rounded-xl border p-1.5 pl-3.5 shadow-lg motion-reduce:animate-none"
    >
      <span className="text-sm font-medium tabular-nums" role="status">
        {count} selected
      </span>
      <span className="bg-border mx-1.5 h-5 w-px" aria-hidden="true" />
      <Button variant="ghost" size="sm" onClick={onMove}>
        <FolderInput /> Move to…
      </Button>
      <Button variant="ghost" size="sm" className="text-destructive hover:text-destructive" onClick={onDelete}>
        <Trash2 /> Delete…
      </Button>
      <span className="bg-border mx-1.5 h-5 w-px" aria-hidden="true" />
      <Button variant="ghost" size="sm" title="Clear the selection (Esc)" onClick={onClear}>
        Clear
      </Button>
    </div>
  );
}

/** a native checkbox that also reports the shift key (range selection) and
 *  shows the mixed state of the select-all box */
function SelectBox({
  checked,
  indeterminate = false,
  label,
  onToggle,
}: {
  checked: boolean;
  indeterminate?: boolean;
  label: string;
  onToggle: (shift: boolean) => void;
}) {
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (ref.current) ref.current.indeterminate = indeterminate;
  }, [indeterminate]);
  return (
    <input
      ref={ref}
      type="checkbox"
      className="accent-primary size-4 cursor-pointer align-middle"
      checked={checked}
      aria-label={label}
      onClick={(e: MouseEvent<HTMLInputElement>) => {
        e.stopPropagation();
        onToggle(e.shiftKey);
      }}
      onChange={() => undefined}
    />
  );
}

interface RowActions {
  onRename: () => void;
  onDuplicate: () => void;
  onMove: () => void;
  onDelete: () => void;
}

/** the per-row "⋯" menu of a model row — rows navigate on click, so neither
 *  the trigger nor the (portalled) content may let a click bubble into it */
function ModelRowMenu({ actions }: { actions: RowActions }) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          variant="ghost"
          size="icon"
          className="size-7"
          title="More actions"
          aria-label="More actions"
          onClick={(e) => e.stopPropagation()}
        >
          <Ellipsis />
        </Button>
      </DropdownMenuTrigger>
      {/* the items open DIALOGS — mount them a tick after radix finished its
          close/focus handling (the New menu's convention) */}
      <DropdownMenuContent
        align="end"
        onClick={(e) => e.stopPropagation()}
        onCloseAutoFocus={(e) => e.preventDefault()}
      >
        <DropdownMenuItem onSelect={() => setTimeout(actions.onRename, 0)}>
          <Pencil /> Rename…
        </DropdownMenuItem>
        <DropdownMenuItem onSelect={() => setTimeout(actions.onDuplicate, 0)}>
          <Copy /> Duplicate…
        </DropdownMenuItem>
        <DropdownMenuItem onSelect={() => setTimeout(actions.onMove, 0)}>
          <FolderInput /> Move to…
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuItem variant="destructive" onSelect={() => setTimeout(actions.onDelete, 0)}>
          <Trash2 /> Delete…
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function SortHeader({ column, children }: { column: Column<typeof features, ProcessInfo>; children: ReactNode }) {
  const sorted = column.getIsSorted();
  return (
    <Button
      variant="ghost"
      size="sm"
      className="-ml-2 h-8 data-[state=open]:bg-accent"
      onClick={() => column.toggleSorting(sorted === "asc")}
    >
      {children}
      {sorted === "asc" ? (
        <ChevronUp className="text-foreground" />
      ) : sorted === "desc" ? (
        <ChevronDown className="text-foreground" />
      ) : (
        <ArrowUpDown className="text-muted-foreground/50" />
      )}
    </Button>
  );
}
