import { QueryClientProvider } from "@tanstack/react-query";
import { RouterProvider } from "@tanstack/react-router";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { apiClient } from "@/lib/api/client";
import { authRedirectFor } from "@/lib/auth";
import { createQueryClient, meQuery } from "@/lib/queries";
import { qk } from "@/lib/query-keys";
import { ThemeProvider } from "@/lib/theme";
import { Toaster } from "@/components/ui/toaster";
import { TooltipProvider } from "@/components/ui/tooltip";
import { createAppRouter } from "./router";
import "./styles.css";

const queryClient = createQueryClient();
const router = createAppRouter(queryClient);

let redirecting = false;
apiClient.configure({
  // Any API call that finds the session gone (or half-authenticated) sends the user to the right
  // page, preserving where they were.
  onAuthError: (error) => {
    const location = router.state.location;
    const target = authRedirectFor(error.code, location.href);
    if (!target || redirecting || location.pathname === target.to) return;
    redirecting = true;
    queryClient.removeQueries({ queryKey: qk.auth.me });
    const nav =
      target.to === "/setup"
        ? router.navigate({ to: "/setup" })
        : router.navigate({ to: target.to, search: { redirect: target.redirect } });
    void nav.finally(() => {
      redirecting = false;
      if (target.to === "/login") queryClient.clear();
    });
  },
  refreshCsrfToken: async () => {
    const me = await queryClient.fetchQuery({ ...meQuery, staleTime: 0 });
    return me.csrfToken;
  },
});

const root = document.getElementById("root");
if (!root) throw new Error("#root element missing");

createRoot(root).render(
  <StrictMode>
    <ThemeProvider>
      <QueryClientProvider client={queryClient}>
        <TooltipProvider delayDuration={300}>
          <RouterProvider router={router} />
          <Toaster />
        </TooltipProvider>
      </QueryClientProvider>
    </ThemeProvider>
  </StrictMode>,
);
