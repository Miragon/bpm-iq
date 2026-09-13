import { Button } from "@bpmiq/ui-kit/components/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@bpmiq/ui-kit/components/card";

import { useConfig } from "@/lib/queries";
import { stashReturnTo } from "@/lib/return-to";

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
              This instance has no browser login configured. Point it at your identity provider (
              <code className="bg-muted rounded px-1">LIVE_OIDC_CLIENT_ID</code> next to the OIDC issuer and JWKS
              variables —{" "}
              <a
                className="underline"
                href="https://github.com/Miragon/bpm-iq/blob/main/docs/on-prem/configuration.md"
                target="_blank"
                rel="noreferrer"
              >
                configuration guide
              </a>
              ), or run it with <code className="bg-muted rounded px-1">LIVE_AUTH=none</code> for a local evaluation
              without any login.
            </p>
          ) : (
            providers.map((p) => (
              <Button key={p.id} asChild className="w-full">
                {/* the deep-link URL is still in the address bar (Login renders
                    in place of the route) — stash it, the auth callback lands
                    on "/" and the root layout restores it */}
                <a href={`/auth/${p.id}`} onClick={stashReturnTo}>
                  Sign in with {p.label}
                </a>
              </Button>
            ))
          )}
          <p className="text-muted-foreground text-xs">
            Sign-in happens on your identity provider's own pages. Which repositories you see is decided by the app
            installation + your write access — releases are created under your name, merge rights stay with the
            repository.
          </p>
        </CardContent>
      </Card>
    </div>
  );
}
