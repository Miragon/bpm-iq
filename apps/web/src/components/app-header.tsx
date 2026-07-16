import { Avatar, AvatarFallback, AvatarImage } from "@bpmiq/ui-kit/components/avatar";
import { Button } from "@bpmiq/ui-kit/components/button";
import { Link } from "@tanstack/react-router";

import type { Me } from "@/lib/api";
import { useLogout } from "@/lib/queries";

export function AppHeader({ me }: { me?: Me }) {
  const logout = useLogout();
  return (
    <header className="flex items-center gap-3 border-b px-5 py-3">
      <Link to="/" className="flex items-baseline gap-2">
        <span className="text-lg font-semibold tracking-tight">bpmiq</span>
        <span className="text-muted-foreground hidden text-xs sm:inline">Let your processes talk</span>
      </Link>
      <div className="flex-1" />
      <a
        href="https://design.miragon.ai"
        target="_blank"
        rel="noreferrer"
        className="text-muted-foreground hover:text-foreground hidden text-xs transition-colors sm:inline"
      >
        design.miragon.ai
      </a>
      {me && (
        <div className="flex items-center gap-2">
          <Avatar className="size-7">
            {me.user.avatarUrl && <AvatarImage src={me.user.avatarUrl} alt="" />}
            <AvatarFallback>{me.user.login.slice(0, 2).toUpperCase()}</AvatarFallback>
          </Avatar>
          <span className="text-muted-foreground text-sm">@{me.user.login}</span>
          <Button variant="ghost" size="sm" onClick={() => logout.mutate()}>
            Logout
          </Button>
        </div>
      )}
    </header>
  );
}
