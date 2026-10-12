import { QueryClientProvider } from "@tanstack/react-query";
import { RouterProvider } from "@tanstack/react-router";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { apiClient } from "@/lib/api/client";
import { createQueryClient, meQuery } from "@/lib/queries";
import { createSessionEndHandler, navigateToAuthPage } from "@/lib/session";
import { ThemeProvider } from "@/lib/theme";
import { Toaster } from "@/components/ui/toaster";
import { TooltipProvider } from "@/components/ui/tooltip";
import { createAppRouter } from "./router";
import "./styles.css";

const queryClient = createQueryClient();
const router = createAppRouter(queryClient);

// Any API call that finds the session gone (or half-authenticated) sends the user to the right
// page, preserving where they were, and forgets the old session's CSRF token.
const onSessionEnd = createSessionEndHandler({
  queryClient,
  location: () => router.state.location,
  navigate: (target) => navigateToAuthPage(router, target),
});

apiClient.configure({
  onAuthError: (error) => void onSessionEnd(error.code),
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
