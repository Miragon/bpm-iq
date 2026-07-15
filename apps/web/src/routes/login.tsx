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
          <CardDescription>
            Gemeinsam modellieren, per Pull Request freigeben — und danach mit den Prozessen reden.
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-3">
          {providers.length === 0 ? (
            <p className="text-muted-foreground text-sm">
              Diese Instanz ist noch nicht mit GitHub verbunden (Anbieter-Schritt, einmalig):{" "}
              <code className="bg-muted rounded px-1">npm run create-app</code> — danach erscheint hier der Login.
            </p>
          ) : (
            providers.map((p) => (
              <Button key={p.id} asChild className="w-full">
                <a href={`/auth/${p.id}`}>Mit {p.label} anmelden</a>
              </Button>
            ))
          )}
          <p className="text-muted-foreground text-xs">
            Die Anmeldung läuft über GitHubs eigene Seiten. Welche Repositories du siehst, entscheiden App-Installation
            + dein Schreibrecht — Releases entstehen unter deinem Namen, Merge-Rechte bleiben beim Repository.
          </p>
        </CardContent>
      </Card>
    </div>
  );
}
