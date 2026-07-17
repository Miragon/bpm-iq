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
import { ArrowDownToLine, ArrowLeft, ArrowUpDown, ChevronDown, ChevronUp } from "lucide-react";
import { type ReactNode, useMemo, useState } from "react";
import { toast } from "sonner";

import { SyncRepoDialog } from "@/components/sync-repo-dialog";
import { type ProcessInfo } from "@/lib/api";
import { useProcesses, useRepos, useSyncRepo } from "@/lib/queries";

const route = getRouteApi("/r/$owner/$repo");

export function ProcessList() {
  const { owner, repo: name } = route.useParams();
  const repo = `${owner}/${name}`;
  const navigate = useNavigate();
  const processes = useProcesses(repo);
  const list = processes.data ?? [];
  const repos = useRepos();
  const branch = repos.data?.find((r) => r.fullName === repo)?.defaultBranch ?? "main";
  const sync = useSyncRepo(repo);
  const [confirmOpen, setConfirmOpen] = useState(false);

  // processes with unreleased live edits the reset would discard, and repos
  // being actively edited (Variant A: a reset can't safely race an open session)
  const dirtyProcesses = list.filter((p) => p.dirty).map((p) => p.name);
  const activeSessions = list.reduce((n, p) => n + p.liveSessions, 0);

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
    data: list,
    columns,
    state: { sorting },
    onSortingChange: setSorting,
    getCoreRowModel: getCoreRowModel(),
    getSortedRowModel: getSortedRowModel(),
  });

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
        {list.length > 0 && (
          <Button
            variant="outline"
            size="sm"
            className="shrink-0"
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
      </div>

      {processes.isLoading ? (
        <p className="text-muted-foreground text-sm">Loading… (the first load clones the repository)</p>
      ) : list.length === 0 ? (
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
