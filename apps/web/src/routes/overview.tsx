import { Badge } from "@bpmiq/ui-kit/components/badge";
import { Button } from "@bpmiq/ui-kit/components/button";
import { Card, CardContent, CardHeader, CardTitle } from "@bpmiq/ui-kit/components/card";
import { useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { Plus, RefreshCw } from "lucide-react";
import { useEffect, useState } from "react";
import { toast } from "sonner";

import { ApiError, fetchRepos, type RepoInfo } from "@/lib/api";
import { openInstallPicker } from "@/lib/install-picker";
import { useConfig, useRepos } from "@/lib/queries";

export function Overview() {
  const qc = useQueryClient();
  const repos = useRepos();
  const cfg = useConfig();
  const installUrl = cfg.data?.installUrl ?? null;
  const [refreshing, setRefreshing] = useState(false);

  // force a registry re-sync from the provider, then update the cache
  const refresh = async () => {
    setRefreshing(true);
    try {
      qc.setQueryData<RepoInfo[]>(["repos"], await fetchRepos(true));
    } catch (e) {
      if (e instanceof ApiError && e.status === 401) {
        void qc.invalidateQueries({ queryKey: ["me"] }); // session gone → flip to login
        return;
      }
      toast.error(e instanceof Error ? e.message : "Refresh failed");
    } finally {
      setRefreshing(false);
    }
  };

  // returned from GitHub's install picker via the same-tab fallback (popup blocked):
  // the server redirects to /?connected=1 → force a fresh sync so the just-added
  // repo shows even if the anonymous webhook-driven sync was coalesced away.
  useEffect(() => {
    const url = new URL(window.location.href);
    if (!url.searchParams.has("connected")) return;
    url.searchParams.delete("connected");
    window.history.replaceState({}, "", url.pathname + url.search + url.hash);
    void refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- run once on mount
  }, []);

  const list = repos.data ?? [];

  return (
    <div className="mx-auto w-full max-w-5xl px-6 py-8">
      <div className="mb-1 flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-2xl font-semibold tracking-tight">Repositories</h1>
        <div className="flex items-center gap-2">
          {installUrl && (
            <Button size="sm" onClick={() => openInstallPicker(installUrl, refresh)}>
              <Plus /> Add repository
            </Button>
          )}
          <Button variant="outline" size="sm" disabled={refreshing} onClick={refresh} title="Reload from GitHub">
            <RefreshCw className={refreshing ? "animate-spin" : ""} /> Refresh
          </Button>
        </div>
      </div>
      <p className="text-muted-foreground mb-6 text-sm">
        Connected process repositories — access follows your GitHub permissions.
      </p>

      {repos.isLoading ? (
        <p className="text-muted-foreground text-sm">Loading…</p>
      ) : list.length === 0 ? (
        <p className="text-muted-foreground max-w-prose text-sm">
          No repositories for your account yet. Use <strong>Add repository</strong> to install the app on one or more
          process repositories
          {installUrl ? "" : " (install URL not configured)"} — then <strong>Refresh</strong>.
        </p>
      ) : (
        <div className="grid gap-3 sm:grid-cols-2">
          {list.map((r) => (
            <Link key={r.fullName} to="/r/$owner/$repo" params={{ owner: r.owner, repo: r.name }} className="block">
              <Card className="hover:border-primary/50 transition-colors">
                <CardHeader>
                  <CardTitle className="flex items-center gap-2 text-base">
                    {r.avatarUrl && <img className="size-5 rounded" src={r.avatarUrl} alt="" />}
                    {r.fullName}
                  </CardTitle>
                  <p className="text-muted-foreground text-sm">
                    {r.defaultBranch}
                    {r.processCount !== null ? ` · ${r.processCount} process(es)` : " · not loaded yet"}
                  </p>
                </CardHeader>
                <CardContent className="flex flex-wrap gap-1.5">
                  {r.suspended ? (
                    <Badge variant="warning">Installation suspended</Badge>
                  ) : (
                    <Badge variant="success">connected</Badge>
                  )}
                  {r.dirtyCount ? <Badge variant="warning">{r.dirtyCount} with live changes</Badge> : null}
                  {r.liveSessions > 0 ? <Badge variant="default">{r.liveSessions} active</Badge> : null}
                </CardContent>
              </Card>
            </Link>
          ))}
        </div>
      )}
    </div>
  );
}
