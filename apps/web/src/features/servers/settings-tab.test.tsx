import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { RouterProvider, createMemoryHistory, createRootRoute, createRouter } from "@tanstack/react-router";
import { act, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SERVER_OWNER_PERMISSIONS } from "@blockforge/contracts";
import type { Permission, Server } from "@blockforge/contracts";
import { apiErrorBody, jsonResponse, makeMe, makeServer } from "@/test/fixtures";
import { ThemeProvider } from "@/lib/theme";
import { TooltipProvider } from "@/components/ui/tooltip";
import SettingsTab from "./tabs/settings-tab";

afterEach(() => vi.unstubAllGlobals());

/** Renders the Settings tab with a server prop the test can replace (as live updates do). */
function renderTab(initial: Server) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => jsonResponse(apiErrorBody("NOT_FOUND"), { status: 404 })),
  );
  let update!: (s: Server) => void;
  function Harness() {
    const [server, setServer] = useState(initial);
    update = setServer;
    return <SettingsTab me={makeMe({ permissions: [] })} server={server} />;
  }
  const router = createRouter({
    routeTree: createRootRoute({ component: Harness }),
    history: createMemoryHistory({ initialEntries: ["/"] }),
  });
  render(
    <ThemeProvider>
      <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
        <TooltipProvider>
          <RouterProvider router={router} />
        </TooltipProvider>
      </QueryClientProvider>
    </ThemeProvider>,
  );
  return { setServer: (s: Server) => act(() => update(s)) };
}

const admin = (over: Partial<Server> = {}) =>
  makeServer({
    myPermissions: [...SERVER_OWNER_PERMISSIONS, "servers.admin"] as Permission[],
    state: "running",
    ...over,
  });

describe("server settings forms during live updates", () => {
  it("keeps unsaved limits and details when the server updates, and flags real changes", async () => {
    const user = userEvent.setup();
    const { setServer } = renderTab(admin());
    const memory = (await screen.findByLabelText(/^Memory limit/)) as HTMLInputElement;
    expect(memory.value).toBe("4096");
    await user.clear(memory);
    await user.type(memory, "6144");
    const name = screen.getByLabelText(/^Name/) as HTMLInputElement;
    await user.clear(name);
    await user.type(name, "Creative");

    // A state change (realtime server.updated) must not wipe the edits.
    setServer(admin({ state: "stopped" }));
    expect((screen.getByLabelText(/^Memory limit/) as HTMLInputElement).value).toBe("6144");
    expect((screen.getByLabelText(/^Name/) as HTMLInputElement).value).toBe("Creative");
    expect(screen.queryByText("Changed elsewhere")).toBeNull();

    // Another admin changed the backup limit and the name: edits kept, both cards say so.
    setServer(admin({ state: "stopped", backupLimit: 9, name: "Renamed elsewhere" }));
    expect(screen.getAllByText("Changed elsewhere")).toHaveLength(2);
    expect((screen.getByLabelText(/^Memory limit/) as HTMLInputElement).value).toBe("6144");
    expect((screen.getByLabelText(/^Name/) as HTMLInputElement).value).toBe("Creative");
    expect((screen.getByLabelText(/^Backup limit/) as HTMLInputElement).value).toBe("3");
  });

  it("follows live updates while the form has no unsaved edits", async () => {
    const { setServer } = renderTab(admin());
    expect(((await screen.findByLabelText(/^Backup limit/)) as HTMLInputElement).value).toBe("3");
    setServer(admin({ backupLimit: 7, name: "Renamed" }));
    expect((screen.getByLabelText(/^Backup limit/) as HTMLInputElement).value).toBe("7");
    expect((screen.getByLabelText(/^Name/) as HTMLInputElement).value).toBe("Renamed");
    expect(screen.queryByText("Changed elsewhere")).toBeNull();
  });
});
