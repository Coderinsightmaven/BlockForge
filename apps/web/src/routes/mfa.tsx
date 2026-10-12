import { createFileRoute, redirect } from "@tanstack/react-router";
import { isApiError } from "@/lib/api/errors";
import { sanitizeRedirect } from "@/lib/auth";
import { meQuery } from "@/lib/queries";
import { MfaPage } from "@/features/auth/auth-pages";

export const Route = createFileRoute("/mfa")({
  validateSearch: (search: Record<string, unknown>): { redirect?: string } => ({
    redirect: typeof search.redirect === "string" ? search.redirect : undefined,
  }),
  beforeLoad: async ({ context, search }) => {
    // A fully verified session has nothing to do here; no session at all goes to login.
    try {
      const me = await context.queryClient.fetchQuery({ ...meQuery, staleTime: 0 });
      if (!me.user.mfaEnabled || me.session.mfaVerified)
        throw redirect({ href: sanitizeRedirect(search.redirect) });
    } catch (err) {
      if (isApiError(err) && err.code === "UNAUTHENTICATED") {
        throw redirect({ to: "/login", search: { redirect: search.redirect } });
      }
      if (!isApiError(err)) throw err; // includes the redirect above
      // MFA_REQUIRED (expected) or a transient API error: show the form.
    }
  },
  component: function Mfa() {
    const { redirect: to } = Route.useSearch();
    return <MfaPage redirect={to} />;
  },
});
