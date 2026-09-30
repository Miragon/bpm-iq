import { Badge } from "@bpmiq/ui-kit/components/badge";
import { Button } from "@bpmiq/ui-kit/components/button";
import { Card, CardContent, CardHeader, CardTitle } from "@bpmiq/ui-kit/components/card";
import { Skeleton } from "@bpmiq/ui-kit/components/skeleton";
import { useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { Copy, Loader2, Plus, RefreshCw } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";

import { ApiError, fetchRepos, type RepoInfo } from "@/lib/api";
import { openInstallPicker } from "@/lib/install-picker";
import { useConfig, useRepos } from "@/lib/queries";

export function Overview() {
  const qc = useQueryClient();
  const repos = useRepos();
  const cfg = useConfig();
  const installUrl = cfg.data?.installUrl ?? null;
  const mcpUrl = cfg.data?.mcpUrl ?? null;
  const [refreshing, setRefreshing] = useState(false);

  const copyMcpUrl = async (url: string) => {
    try {
      await navigator.clipboard.writeText(url);
      toast.success("MCP server URL copied", { description: url });
    } catch {
      // clipboard needs a secure context (https/localhost) — show the URL to copy by hand
      toast.info("MCP server URL", { description: url, duration: 15_000 });
    }
  };

  // force a registry re-sync from the provider, then update the cache
  const refresh = async () => {
    setRefreshing(true);
    try {
      const fresh = await fetchRepos(true);
      // a background revalidation still in flight must not land AFTER this
      // forced result and overwrite it with the pre-sync list
      await qc.cancelQueries({ queryKey: ["repos"] });
      qc.setQueryData<RepoInfo[]>(["repos"], fresh);
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

  // a failed load or background revalidation is never silent; an expired
  // session flips to the login instead. One toast per failure — an error the
  // cache still holds from before this visit is not announced again.
  const reportedErrorAt = useRef(repos.errorUpdatedAt);
  useEffect(() => {
    const e = repos.error;
    if (!e || repos.errorUpdatedAt <= reportedErrorAt.current) return;
    reportedErrorAt.current = repos.errorUpdatedAt;
    if (e instanceof ApiError && e.status === 401) {
      void qc.invalidateQueries({ queryKey: ["me"] });
      return;
    }
    toast.error("Could not update the repository list", { description: e.message });
  }, [repos.error, repos.errorUpdatedAt, qc]);

  const list = repos.data ?? [];
  // the list on screen is the last known one while the background refresh runs (#212)
  const updating = repos.isFetching && !repos.isPending;

  return (
    <div className="mx-auto w-full max-w-5xl px-6 py-8">
      <div className="mb-1 flex flex-wrap items-center justify-between gap-3">
        <h1 className="flex items-center gap-2 text-2xl font-semibold tracking-tight">
          Repositories
          {updating && (
            <Loader2
              role="status"
              aria-label="Updating the repository list"
              className="text-muted-foreground size-4 animate-spin motion-reduce:animate-none"
            />
          )}
        </h1>
        <div className="flex items-center gap-2">
          {installUrl && (
            <Button size="sm" onClick={() => openInstallPicker(installUrl, refresh)}>
              <Plus /> Add repository
            </Button>
          )}
          <Button variant="outline" size="sm" disabled={refreshing} onClick={refresh} title="Reload from GitHub">
            <RefreshCw className={refreshing ? "animate-spin" : ""} /> Refresh
          </Button>
          {mcpUrl && (
            <Button
              variant="outline"
              size="sm"
              title="Copy the MCP server URL — connect Claude or another AI client"
              onClick={() => copyMcpUrl(mcpUrl)}
            >
              <Copy /> MCP
            </Button>
          )}
        </div>
      </div>
      <p className="text-muted-foreground mb-6 text-sm">
        Connected process repositories — access follows your GitHub permissions.
      </p>

      {repos.isLoading ? (
        <RepoCardSkeletons />
      ) : repos.isError && !repos.data ? (
        <p className="text-muted-foreground max-w-prose text-sm">
          The repository list could not be loaded — try <strong>Refresh</strong>.
        </p>
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
                    {/* != null guards BOTH null and a pre-3.4 server that does not send the field */}
                    {r.decisionCount != null && r.decisionCount > 0 ? ` · ${r.decisionCount} decision(s)` : ""}
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

/** the first load without a cached list: placeholders in the card grid's shape */
function RepoCardSkeletons() {
  return (
    <div className="grid gap-3 sm:grid-cols-2" aria-busy="true" aria-label="Loading repositories">
      {Array.from({ length: 4 }, (_, i) => (
        <Card key={i}>
          <CardHeader>
            <div className="flex items-center gap-2">
              <Skeleton className="size-5" />
              <Skeleton className="h-4 w-40" />
            </div>
            <Skeleton className="h-4 w-52" />
          </CardHeader>
          <CardContent>
            <Skeleton className="h-5 w-20" />
          </CardContent>
        </Card>
      ))}
    </div>
  );
}
