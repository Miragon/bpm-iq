import { Outlet, useRouter } from "@tanstack/react-router";
import { Loader2 } from "lucide-react";
import { useEffect } from "react";
import { Toaster } from "sonner";

import { AppHeader } from "@/components/app-header";
import { useMe } from "@/lib/queries";
import { takeReturnTo } from "@/lib/return-to";
import { Login } from "@/routes/login";

export function RootLayout() {
  const me = useMe();
  const router = useRouter();
  // the login callbacks land on "/" — pick the stashed deep link back up once
  // the session is real. Only on "/", so an explicit navigation never gets
  // hijacked; replace, so Back skips the intermediate overview.
  const restorable = Boolean(me.data) && window.location.pathname === "/";
  useEffect(() => {
    if (!restorable) return;
    const target = takeReturnTo();
    if (target) void router.history.replace(target);
  }, [restorable, router]);
  return (
    <div className="flex h-full flex-col">
      <AppHeader me={me.data} />
      <main className="min-h-0 flex-1">
        {me.isLoading ? (
          <div className="flex items-center justify-center py-24">
            <Loader2 className="text-muted-foreground size-6 animate-spin" />
          </div>
        ) : me.isError || !me.data ? (
          <Login />
        ) : (
          <Outlet />
        )}
      </main>
      <Toaster richColors position="bottom-center" />
    </div>
  );
}
