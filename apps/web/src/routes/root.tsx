import { Outlet } from "@tanstack/react-router";
import { Loader2 } from "lucide-react";
import { Toaster } from "sonner";

import { AppHeader } from "@/components/app-header";
import { useMe } from "@/lib/queries";
import { Login } from "@/routes/login";

export function RootLayout() {
  const me = useMe();
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
