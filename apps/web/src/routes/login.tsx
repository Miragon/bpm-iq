import { Button } from "@bpmiq/ui-kit/components/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@bpmiq/ui-kit/components/card";

import { useConfig } from "@/lib/queries";

export function Login() {
  const cfg = useConfig();
  const providers = cfg.data?.providers ?? [];
  return (
    <div className="mx-auto flex max-w-md flex-col px-6 py-20">
      <Card>
        <CardHeader className="text-center">
          <CardTitle className="text-2xl">bpmiq Live</CardTitle>
          <CardDescription>Model together, release via pull request — then talk to your processes.</CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-3">
          {providers.length === 0 ? (
            <p className="text-muted-foreground text-sm">
              This instance is not connected to GitHub yet (one-time provider step):{" "}
              <code className="bg-muted rounded px-1">npm run create-app</code> — the login appears here afterwards.
            </p>
          ) : (
            providers.map((p) => (
              <Button key={p.id} asChild className="w-full">
                <a href={`/auth/${p.id}`}>Sign in with {p.label}</a>
              </Button>
            ))
          )}
          <p className="text-muted-foreground text-xs">
            Sign-in happens on GitHub's own pages. Which repositories you see is decided by the app installation + your
            write access — releases are created under your name, merge rights stay with the repository.
          </p>
        </CardContent>
      </Card>
    </div>
  );
}
