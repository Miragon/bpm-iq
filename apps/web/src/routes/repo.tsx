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
        Live modellieren — jede Freigabe wird ein reviewbarer Pull Request.
      </p>

      {processes.isLoading ? (
        <p className="text-muted-foreground text-sm">Lade … (erster Aufruf klont das Repository)</p>
      ) : list.length === 0 ? (
        <p className="text-muted-foreground max-w-prose text-sm">
          Keine Prozesse gefunden — entspricht dieses Repository dem Starter-Layout (
          <code className="bg-muted rounded px-1">processes/&lt;id&gt;/process.yaml</code>)?
        </p>
      ) : (
        <div className="grid gap-3 sm:grid-cols-2">
          {list.map((p) => (
            <Card key={p.id}>
              <CardHeader>
                <CardTitle className="text-base">
                  {p.bpmn ? (
                    <Link
                      to="/r/$owner/$repo/p/$processId"
                      params={{ owner, repo: name, processId: p.id }}
                      className="hover:underline"
                    >
                      {p.name}
                    </Link>
                  ) : (
                    p.name
                  )}
                </CardTitle>
                <p className="text-muted-foreground text-sm">
                  {[p.classification, p.version ? `v${p.version}` : null, p.owner].filter(Boolean).join(" · ")}
                </p>
              </CardHeader>
              <CardContent className="flex flex-col gap-2">
                <div className="flex flex-wrap gap-1.5">
                  <Badge variant="success">released: {p.status ?? "—"}</Badge>
                  {p.dirty && <Badge variant="warning">live-Änderungen</Badge>}
                  {p.liveSessions > 0 && <Badge>{p.liveSessions} aktiv</Badge>}
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
