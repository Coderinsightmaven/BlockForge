import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { RouterProvider, createMemoryHistory, createRootRoute, createRouter } from "@tanstack/react-router";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { apiErrorBody, jsonResponse, makeMe } from "@/test/fixtures";
import { ThemeProvider } from "@/lib/theme";
import { TooltipProvider } from "@/components/ui/tooltip";
import { EnrollmentDialogProvider } from "@/features/nodes/enrollment-dialog";
import { CommandPalette } from "./command-palette";

afterEach(() => vi.unstubAllGlobals());

function renderPalette() {
  // No data endpoints are needed: the searches failing must not break pages and actions.
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => jsonResponse(apiErrorBody("NOT_FOUND"), { status: 404 })),
  );
  const me = makeMe({ permissions: ["nodes.view", "nodes.enroll"] });
  const root = createRootRoute({ component: () => <CommandPalette me={me} /> });
  const router = createRouter({ routeTree: root, history: createMemoryHistory({ initialEntries: ["/"] }) });
  render(
    <ThemeProvider>
      <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
        <TooltipProvider>
          <EnrollmentDialogProvider>
            <RouterProvider router={router} />
          </EnrollmentDialogProvider>
        </TooltipProvider>
      </QueryClientProvider>
    </ThemeProvider>,
  );
}

describe("CommandPalette (loaded on first use)", () => {
  it("opens with Ctrl+K once its chunk loads, and its actions open the (also lazy) enrollment dialog", async () => {
    const user = userEvent.setup();
    renderPalette();
    expect(await screen.findByRole("button", { name: "Search" })).toBeTruthy();
    expect(screen.queryByPlaceholderText(/Search servers/)).toBeNull();

    await user.keyboard("{Control>}k{/Control}");
    const input = await screen.findByPlaceholderText(/Search servers/);
    await user.type(input, "enroll");
    await user.click(await screen.findByRole("option", { name: /Enroll node/ }));

    expect(screen.queryByPlaceholderText(/Search servers/)).toBeNull();
    expect(await screen.findByLabelText(/^Label/)).toBeTruthy();
  });

  it("opens from the search button", async () => {
    const user = userEvent.setup();
    renderPalette();
    await user.click(await screen.findByRole("button", { name: "Search" }));
    expect(await screen.findByPlaceholderText(/Search servers/)).toBeTruthy();
  });
});
