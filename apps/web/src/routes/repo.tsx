import { Badge } from "@bpmiq/ui-kit/components/badge";
import { Button } from "@bpmiq/ui-kit/components/button";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@bpmiq/ui-kit/components/table";
import { getRouteApi, Link, useNavigate } from "@tanstack/react-router";
import {
  type Column,
  type ColumnDef,
  flexRender,
  getCoreRowModel,
  getSortedRowModel,
  type SortingState,
  useReactTable,
} from "@tanstack/react-table";
import {
  ArrowDownToLine,
  ArrowLeft,
  ArrowUpDown,
  ChevronDown,
  ChevronUp,
  Folder,
  FolderPlus,
  Plus,
} from "lucide-react";
import { type ReactNode, useMemo, useState } from "react";
import { toast } from "sonner";

import { CreateFolderDialog } from "@/components/create-folder-dialog";
import { CreateProcessDialog } from "@/components/create-process-dialog";
import { SyncRepoDialog } from "@/components/sync-repo-dialog";
import { type ProcessInfo } from "@/lib/api";
import { useFolders, useProcesses, useRepos, useSyncRepo } from "@/lib/queries";

const route = getRouteApi("/r/$owner/$repo");

/** one sub-folder row of the current directory, with aggregated child stats */
interface FolderRow {
  name: string;
  /** processes-root-relative path */
  path: string;
  processCount: number;
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
  const folders = useFolders(repo);
  const repos = useRepos();
  const branch = repos.data?.find((r) => r.fullName === repo)?.defaultBranch ?? "main";
  const sync = useSyncRepo(repo);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [folderOpen, setFolderOpen] = useState(false);
  const [processOpen, setProcessOpen] = useState(false);

  // processes with unreleased live edits the reset would discard, and repos
  // being actively edited (Variant A: a reset can't safely race an open session)
  const dirtyProcesses = list.filter((p) => p.dirty).map((p) => p.name);
  const activeSessions = list.reduce((n, p) => n + p.liveSessions, 0);

  // the folder tree: disk folders (includes empty ones) ∪ ancestors of every
  // process path — so rows render even while the folders query is still loading
  const folderSet = useMemo(() => {
    const set = new Set<string>(folders.data ?? []);
    for (const p of list) {
      for (let f = p.folder; f !== ""; f = parentOf(f)) set.add(f);
    }
    return set;
  }, [folders.data, list]);

  const childFolders = useMemo<FolderRow[]>(
    () =>
      [...folderSet]
        .filter((f) => parentOf(f) === dir)
        .sort()
        .map((path) => {
          const inside = list.filter((p) => p.folder === path || p.folder.startsWith(`${path}/`));
          return {
            name: path.split("/").pop() ?? path,
            path,
            processCount: inside.length,
            dirty: inside.some((p) => p.dirty),
          };
        }),
    [folderSet, list, dir],
  );

  const visible = useMemo(() => list.filter((p) => p.folder === dir), [list, dir]);
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
    if (dirtyProcesses.length > 0) setConfirmOpen(true);
    else runSync();
  };

  const [sorting, setSorting] = useState<SortingState>([{ id: "name", desc: false }]);

  const columns = useMemo<ColumnDef<ProcessInfo>[]>(
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
    ],
    [owner, name],
  );

  const table = useReactTable({
    data: visible,
    columns,
    state: { sorting },
    onSortingChange: setSorting,
    getCoreRowModel: getCoreRowModel(),
    getSortedRowModel: getSortedRowModel(),
  });

  const empty = childFolders.length === 0 && visible.length === 0;

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
          {list.length > 0 && (
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
          <Button variant="outline" size="sm" onClick={() => setFolderOpen(true)}>
            <FolderPlus /> New folder
          </Button>
          <Button size="sm" onClick={() => setProcessOpen(true)}>
            <Plus /> New process
          </Button>
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
          No processes found — a BPM repository needs a <code className="bg-muted rounded px-1">bpmiq.yml</code> at its
          root naming the folder its BPMN files live in (
          <code className="bg-muted rounded px-1">processes: processes</code>).
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
                      {f.processCount === 0 ? "empty" : `${f.processCount} process${f.processCount === 1 ? "" : "es"}`}
                    </span>
                  </TableCell>
                  <TableCell>
                    {f.dirty ? (
                      <Badge variant="warning">live changes</Badge>
                    ) : (
                      <span className="text-muted-foreground">—</span>
                    )}
                  </TableCell>
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
                  {row.getVisibleCells().map((cell) => (
                    <TableCell key={cell.id}>{flexRender(cell.column.columnDef.cell, cell.getContext())}</TableCell>
                  ))}
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}

      {confirmOpen && (
        <SyncRepoDialog
          branch={branch}
          dirtyProcesses={dirtyProcesses}
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
    </div>
  );
}

function SortHeader({ column, children }: { column: Column<ProcessInfo>; children: ReactNode }) {
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
