import { Outlet, createFileRoute, useRouter } from "@tanstack/react-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useMemo } from "react";
import { isApiError } from "@/lib/api/errors";
import { requireSession } from "@/lib/auth";
import { meQuery } from "@/lib/queries";
import { createSessionEndHandler, navigateToAuthPage } from "@/lib/session";
import { useMe } from "@/lib/use-me";
import { AppShell } from "@/components/shell/app-shell";

/**
 * Sends the user to login/MFA when a background refresh of `me` finds the session gone (that
 * request skips the API client's global auth handler, so it is handled here the same way).
 */
function SessionWatch() {
  const router = useRouter();
  const queryClient = useQueryClient();
  const { error } = useQuery(meQuery);
  const onSessionEnd = useMemo(
    () =>
      createSessionEndHandler({
        queryClient,
        location: () => router.state.location,
        navigate: (target) => navigateToAuthPage(router, target),
      }),
    [queryClient, router],
  );
  useEffect(() => {
    if (isApiError(error)) onSessionEnd(error.code);
  }, [error, onSessionEnd]);
  return null;
}

/** Authenticated area: every child route requires a fully verified session. */
export const Route = createFileRoute("/_app")({
  beforeLoad: async ({ context, location }) => {
    const me = await requireSession(context.queryClient, location.href);
    return { me };
  },
  component: function AppLayout() {
    const me = useMe();
    return (
      <AppShell me={me}>
        <SessionWatch />
        <Outlet />
      </AppShell>
    );
  },
});
