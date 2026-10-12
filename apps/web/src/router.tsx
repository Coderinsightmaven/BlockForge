import { createRouter } from "@tanstack/react-router";
import type { QueryClient } from "@tanstack/react-query";
import { Skeleton } from "@/components/ui/skeleton";
import { routeTree } from "./routeTree.gen";

function PendingPage() {
  return (
    <div className="flex flex-col gap-3 p-6" aria-busy aria-label="Loading">
      <Skeleton className="h-7 w-56" />
      <Skeleton className="h-40 w-full" />
    </div>
  );
}

export function createAppRouter(queryClient: QueryClient) {
  return createRouter({
    routeTree,
    context: { queryClient },
    defaultPreload: "intent",
    // Data freshness is owned by TanStack Query.
    defaultPreloadStaleTime: 0,
    defaultPendingComponent: PendingPage,
    defaultPendingMs: 400,
    scrollRestoration: true,
  });
}

export type AppRouter = ReturnType<typeof createAppRouter>;

declare module "@tanstack/react-router" {
  interface Register {
    router: AppRouter;
  }
}
