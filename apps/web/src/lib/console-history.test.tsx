import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  RouterProvider,
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
} from "@tanstack/react-router";
import { act, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SERVER_ID, makeMe } from "@/test/fixtures";
import { useLogout } from "@/components/shell/user-menu";
import { COMMAND_HISTORY_MAX, addCommand, clearConsoleHistories, getCommandHistory } from "./console-history";
import { createSessionEndHandler } from "./session";
import { qk } from "./query-keys";

const OTHER = "44444444-4444-4444-8444-444444444444";

afterEach(() => {
  clearConsoleHistories();
  sessionStorage.clear();
  localStorage.clear();
  vi.unstubAllGlobals();
});

describe("console command history", () => {
  it("lives in memory only (commands can carry secrets), per server, de-duplicated and capped", () => {
    addCommand(SERVER_ID, "say hi");
    addCommand(SERVER_ID, "login hunter2");
    addCommand(SERVER_ID, "say hi");
    addCommand(OTHER, "list");
    expect(getCommandHistory(SERVER_ID)).toEqual(["login hunter2", "say hi"]);
    expect(getCommandHistory(OTHER)).toEqual(["list"]);
    for (let i = 0; i < COMMAND_HISTORY_MAX + 10; i++) addCommand(SERVER_ID, `cmd ${i}`);
    expect(getCommandHistory(SERVER_ID)).toHaveLength(COMMAND_HISTORY_MAX);
    const stored = JSON.stringify({ ...sessionStorage }) + JSON.stringify({ ...localStorage });
    expect(stored).not.toContain("hunter2");
    expect(stored).not.toContain("cmd 1");
  });

  it("clearing forgets every server and removes copies an older build left in sessionStorage", () => {
    addCommand(SERVER_ID, "op someone");
    sessionStorage.setItem(`blockforge.console-history.${SERVER_ID}`, JSON.stringify(["op someone"]));
    sessionStorage.setItem("blockforge.other", "keep");
    clearConsoleHistories();
    expect(getCommandHistory(SERVER_ID)).toEqual([]);
    expect(sessionStorage.getItem(`blockforge.console-history.${SERVER_ID}`)).toBeNull();
    expect(sessionStorage.getItem("blockforge.other")).toBe("keep");
  });

  it("is wiped when the session ends (expired / revoked / another account signs in)", () => {
    addCommand(SERVER_ID, "whitelist add friend");
    const queryClient = new QueryClient();
    const handler = createSessionEndHandler({
      queryClient,
      client: { setCsrfToken: vi.fn() },
      navigate: () => new Promise(() => {}),
      location: () => ({ pathname: "/servers", href: "/servers" }),
    });
    handler("UNAUTHENTICATED");
    expect(getCommandHistory(SERVER_ID)).toEqual([]);
  });

  it("is wiped on sign-out", async () => {
    addCommand(SERVER_ID, "whitelist add friend");
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(null, { status: 204 })),
    );
    const queryClient = new QueryClient();
    queryClient.setQueryData(qk.auth.me, makeMe());
    function SignOut() {
      const { logout } = useLogout();
      return (
        <button type="button" onClick={() => void logout()}>
          Sign out
        </button>
      );
    }
    const root = createRootRoute();
    const home = createRoute({ getParentRoute: () => root, path: "/", component: SignOut });
    const login = createRoute({
      getParentRoute: () => root,
      path: "/login",
      component: () => <p>Login page</p>,
    });
    const router = createRouter({
      routeTree: root.addChildren([home, login]),
      history: createMemoryHistory({ initialEntries: ["/"] }),
    });
    render(
      <QueryClientProvider client={queryClient}>
        <RouterProvider router={router} />
      </QueryClientProvider>,
    );
    const button = await screen.findByRole("button", { name: "Sign out" });
    await act(async () => button.click());
    await screen.findByText("Login page");
    expect(getCommandHistory(SERVER_ID)).toEqual([]);
  });
});
