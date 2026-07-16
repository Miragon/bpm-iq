import { createRootRoute, createRoute, createRouter } from "@tanstack/react-router";

import { FileEditorScreen, ProcessEditorScreen } from "@/routes/editor";
import { Overview } from "@/routes/overview";
import { ProcessList } from "@/routes/repo";
import { RootLayout } from "@/routes/root";

const rootRoute = createRootRoute({ component: RootLayout });

const overviewRoute = createRoute({ getParentRoute: () => rootRoute, path: "/", component: Overview });
// repo = owner/name (GitHub). GitLab subgroups (multi-segment) are a follow-up —
// they'd need the repo captured as a splat instead of two params.
const repoRoute = createRoute({ getParentRoute: () => rootRoute, path: "/r/$owner/$repo", component: ProcessList });
const processEditorRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/r/$owner/$repo/p/$processId",
  // deep links (e.g. from todo/issue bodies): ?element=<bpmn element id> reveals
  // that element once after the diagram's first import; unknown ids are ignored
  validateSearch: (search: Record<string, unknown>): { element?: string } => ({
    element: typeof search.element === "string" && search.element.length > 0 ? search.element : undefined,
  }),
  component: ProcessEditorScreen,
});
const fileEditorRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/r/$owner/$repo/f/$",
  component: FileEditorScreen,
});

const routeTree = rootRoute.addChildren([overviewRoute, repoRoute, processEditorRoute, fileEditorRoute]);

export const router = createRouter({ routeTree, defaultPreload: "intent" });

declare module "@tanstack/react-router" {
  interface Register {
    router: typeof router;
  }
}
