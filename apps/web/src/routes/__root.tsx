import { Outlet, createRootRouteWithContext, useRouter } from "@tanstack/react-router";
import type { ErrorComponentProps } from "@tanstack/react-router";
import type { QueryClient } from "@tanstack/react-query";
import { FileQuestion } from "lucide-react";
import { EmptyState, ErrorState } from "@/components/common/states";
import { Button } from "@/components/ui/button";

export interface RouterContext {
  queryClient: QueryClient;
}

function RootError({ error, reset }: ErrorComponentProps) {
  const router = useRouter();
  return (
    <div className="flex min-h-full items-center justify-center p-6">
      <ErrorState
        error={error}
        title="This page failed to load"
        onRetry={() => {
          reset();
          void router.invalidate();
        }}
      />
    </div>
  );
}

function NotFound() {
  return (
    <div className="flex min-h-full items-center justify-center p-6">
      <EmptyState
        icon={FileQuestion}
        title="Page not found"
        description="The address does not match any page in BlockForge."
        action={
          <Button asChild variant="outline">
            <a href="/">Go to Overview</a>
          </Button>
        }
      />
    </div>
  );
}

export const Route = createRootRouteWithContext<RouterContext>()({
  component: Outlet,
  errorComponent: RootError,
  notFoundComponent: NotFound,
});
