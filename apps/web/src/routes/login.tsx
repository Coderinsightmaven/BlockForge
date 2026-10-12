import { createFileRoute, redirect } from "@tanstack/react-router";
import { redirectIfSignedIn } from "@/lib/auth";
import { setupStatusQuery } from "@/lib/queries";
import { LoginPage } from "@/features/auth/auth-pages";

export const Route = createFileRoute("/login")({
  validateSearch: (search: Record<string, unknown>): { redirect?: string } => ({
    redirect: typeof search.redirect === "string" ? search.redirect : undefined,
  }),
  beforeLoad: async ({ context, search }) => {
    const setup = await context.queryClient.fetchQuery(setupStatusQuery).catch(() => null);
    if (setup?.setupRequired) throw redirect({ to: "/setup" });
    await redirectIfSignedIn(context.queryClient, search.redirect);
  },
  component: function Login() {
    const { redirect: to } = Route.useSearch();
    return <LoginPage redirect={to} />;
  },
});
