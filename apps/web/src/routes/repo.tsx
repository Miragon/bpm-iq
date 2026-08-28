import { byId } from "@bpmiq/notations";
import { type NotationDescriptor, NOTATIONS } from "@bpmiq/notations";
import { hasTemplate } from "@bpmiq/notations/templates";
import { Badge } from "@bpmiq/ui-kit/components/badge";
import { Button } from "@bpmiq/ui-kit/components/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@bpmiq/ui-kit/components/dropdown-menu";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@bpmiq/ui-kit/components/table";
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
  ChartNetwork,
  ChevronDown,
  ChevronUp,
  FileText,
  Folder,
  FolderPlus,
  Plus,
  Shapes,
  Table2,
  Users,
  Workflow,
} from "lucide-react";
import { type ComponentType, type ReactNode, useMemo, useState } from "react";
import { toast } from "sonner";

import { AssistMenu } from "@/components/assist-menu";
import { CreateDecisionDialog } from "@/components/create-decision-dialog";
import { CreateFolderDialog } from "@/components/create-folder-dialog";
import { CreateNotationModelDialog } from "@/components/create-notation-model-dialog";
import { CreateProcessDialog } from "@/components/create-process-dialog";
import { ReleaseDialog } from "@/components/release-dialog";
import { SyncRepoDialog } from "@/components/sync-repo-dialog";
import { type ProcessInfo } from "@/lib/api";
import { useDecisions, useFolders, useModels, useProcesses, useRepos, useSyncRepo } from "@/lib/queries";

const route = getRouteApi("/r/$owner/$repo");

/** notations the "New" menu offers GENERICALLY (#139): everything with a
 *  blank template except bpmn/dmn, which keep their typed flows above */
const CREATABLE_NOTATIONS = NOTATIONS.filter((n) => hasTemplate(n.id) && n.id !== "bpmn" && n.id !== "dmn");

/** each notation's menu icon — one a user can GUESS from the label. A notation
 *  without an entry falls back to the neutral Shapes, so a new registry entry
 *  never ships icon-less */
const NOTATION_ICONS = new Map<string, ComponentType<{ className?: string }>>([
  ["wardley", ChartNetwork],
  ["team-topology", Users],
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

  const visible = useMemo(() => list.filter((p) => p.folder === dir), [list, dir]);
  const visibleDecisions = useMemo(
    () => decisions.filter((d) => d.folder === dir).sort((a, b) => a.name.localeCompare(b.name)),
    [decisions, dir],
  );
  const visibleModels = useMemo(
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
          <AssistMenu repo={`${owner}/${name}`} path={row.original.bpmn} notation="bpmn" variant="row" />
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

  const empty =
    childFolders.length === 0 && visible.length === 0 && visibleDecisions.length === 0 && visibleModels.length === 0;

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
          <Link to="/r/$owner/$repo" params={{ owner, repo: name }} className="text-muted-foreground hover:underline">
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
                    className="text-muted-foreground hover:underline"
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
                  className="cursor-pointer"
                  onClick={() =>
                    navigate({ to: "/r/$owner/$repo", params: { owner, repo: name }, search: { dir: f.path } })
                  }
                >
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
              {table.getRowModel().rows.map((row) => (
                <TableRow
                  key={row.id}
                  className="cursor-pointer"
                  onClick={() =>
                    navigate({
                      to: "/r/$owner/$repo/p/$processId",
                      params: { owner, repo: name, processId: row.original.id },
                    })
                  }
                >
                  {row.getAllCells().map((cell) => (
                    <TableCell key={cell.id}>{flexRender(cell.column.columnDef.cell, cell.getContext())}</TableCell>
                  ))}
                </TableRow>
              ))}
              {visibleDecisions.map((d) => (
                <TableRow
                  key={`decision:${d.path}`}
                  className="cursor-pointer"
                  onClick={() => navigate({ to: "/r/$owner/$repo/f/$", params: { owner, repo: name, _splat: d.path } })}
                >
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
                    <AssistMenu repo={repo} path={d.path} notation="dmn" variant="row" />
                  </TableCell>
                </TableRow>
              ))}
              {visibleModels.map((m) => (
                <TableRow
                  key={`model:${m.path}`}
                  className="cursor-pointer"
                  onClick={() => navigate({ to: "/r/$owner/$repo/f/$", params: { owner, repo: name, _splat: m.path } })}
                >
                  <TableCell>
                    <Link
                      to="/r/$owner/$repo/f/$"
                      params={{ owner, repo: name, _splat: m.path }}
                      className="flex items-center gap-2 font-medium hover:underline"
                      onClick={(e) => e.stopPropagation()}
                    >
                      <Shapes className="text-muted-foreground size-4" />
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
                  <TableCell />
                </TableRow>
              ))}
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
            toast.success(`Folder '${path}' created`);
            void navigate({ to: "/r/$owner/$repo", params: { owner, repo: name }, search: { dir: path } });
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
    </div>
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
