import { Badge } from "@bpmiq/ui-kit/components/badge";
import { Button } from "@bpmiq/ui-kit/components/button";
import { Card, CardContent, CardHeader, CardTitle } from "@bpmiq/ui-kit/components/card";
import { getRouteApi, Link } from "@tanstack/react-router";
import { ArrowLeft } from "lucide-react";

import { useProcesses } from "@/lib/queries";

const route = getRouteApi("/r/$owner/$repo");

export function ProcessList() {
  const { owner, repo: name } = route.useParams();
  const repo = `${owner}/${name}`;
  const processes = useProcesses(repo);
  const list = processes.data ?? [];

  return (
    <div className="mx-auto w-full max-w-5xl px-6 py-8">
      <Button asChild variant="ghost" size="sm" className="mb-2 -ml-2">
        <Link to="/">
          <ArrowLeft /> Repositories
        </Link>
      </Button>
      <h1 className="text-2xl font-semibold tracking-tight">{repo}</h1>
      <p className="text-muted-foreground mb-6 text-sm">
        Model live — every release becomes a reviewable pull request.
      </p>

      {processes.isLoading ? (
        <p className="text-muted-foreground text-sm">Loading… (the first load clones the repository)</p>
      ) : list.length === 0 ? (
        <p className="text-muted-foreground max-w-prose text-sm">
          No processes found — a BPM repository needs a <code className="bg-muted rounded px-1">bpmiq.yml</code> at its
          root naming the folder its BPMN files live in (
          <code className="bg-muted rounded px-1">processes: processes</code>).
        </p>
      ) : (
        <div className="grid gap-3 sm:grid-cols-2">
          {list.map((p) => (
            <Card key={p.id}>
              <CardHeader>
                <CardTitle className="text-base">
                  <Link
                    to="/r/$owner/$repo/p/$processId"
                    params={{ owner, repo: name, processId: p.id }}
                    className="hover:underline"
                  >
                    {p.name}
                  </Link>
                </CardTitle>
                <p className="text-muted-foreground text-sm">{p.bpmn}</p>
              </CardHeader>
              <CardContent className="flex flex-col gap-2">
                <div className="flex flex-wrap gap-1.5">
                  {p.dirty && <Badge variant="warning">live changes</Badge>}
                  {p.liveSessions > 0 && <Badge>{p.liveSessions} active</Badge>}
                </div>
                {p.models.length > 0 && (
                  <div className="flex flex-wrap gap-1.5">
                    {p.models.map((m) => (
                      <Link
                        key={m.path}
                        to="/r/$owner/$repo/f/$"
                        params={{ owner, repo: name, _splat: m.path }}
                        title={m.path}
                      >
                        <Badge variant="outline" className="hover:bg-accent">
                          {m.notation}: {m.path.split("/").pop()}
                        </Badge>
                      </Link>
                    ))}
                  </div>
                )}
              </CardContent>
            </Card>
          ))}
        </div>
      )}
    </div>
  );
}
