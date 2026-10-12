import { Outlet, createFileRoute, useNavigate, useRouterState } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { useEffect } from "react";
import { isApiError } from "@/lib/api/errors";
import { authRedirectFor, requireSession } from "@/lib/auth";
import { meQuery } from "@/lib/queries";
import { useMe } from "@/lib/use-me";
import { AppShell } from "@/components/shell/app-shell";

/** Sends the user to login/MFA when a background refresh of `me` finds the session gone. */
function SessionWatch() {
  const navigate = useNavigate();
  const href = useRouterState({ select: (s) => s.location.href });
  const { error } = useQuery(meQuery);
  useEffect(() => {
    if (!isApiError(error)) return;
    const target = authRedirectFor(error.code, href);
    if (!target) return;
    if (target.to === "/setup") void navigate({ to: "/setup" });
    else void navigate({ to: target.to, search: { redirect: target.redirect } });
  }, [error, href, navigate]);
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
