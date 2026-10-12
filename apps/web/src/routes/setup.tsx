import { createFileRoute, redirect } from "@tanstack/react-router";
import { setupStatusQuery } from "@/lib/queries";
import { SetupPage } from "@/features/auth/auth-pages";

export const Route = createFileRoute("/setup")({
  beforeLoad: async ({ context }) => {
    const setup = await context.queryClient.fetchQuery(setupStatusQuery);
    if (!setup.setupRequired) throw redirect({ to: "/login", search: { redirect: undefined } });
  },
  component: SetupPage,
});
