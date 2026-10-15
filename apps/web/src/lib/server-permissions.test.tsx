import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { RouterProvider, createMemoryHistory, createRootRoute, createRouter } from "@tanstack/react-router";
import { render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SERVER_OWNER_PERMISSIONS, SUBUSER_ASSIGNABLE_PERMISSIONS } from "@blockforge/contracts";
import type { Permission } from "@blockforge/contracts";
import { makeServer } from "@/test/fixtures";
import { ThemeProvider } from "@/lib/theme";
import { TooltipProvider } from "@/components/ui/tooltip";
import { PowerControls, powerActionState } from "@/features/servers/server-common";
import { PermissionMatrix } from "@/features/servers/tabs/users-tab";
import {
  SUBUSER_PERMISSION_GROUPS,
  grantablePermissions,
  normalizeGrant,
  resolveServerTab,
  serverActionable,
  visibleServerTabs,
} from "./server-permissions";

afterEach(() => vi.unstubAllGlobals());

describe("server tab gating (myPermissions)", () => {
  it("an owner sees every tab", () => {
    const tabs = visibleServerTabs(makeServer()).map((t) => t.id);
    expect(tabs).toEqual([
      "console",
      "stats",
      "files",
      "extensions",
      "players",
      "backups",
      "databases",
      "schedules",
      "startup",
      "network",
      "users",
      "activity",
      "settings",
    ]);
  });

  it("hides Backups when the limit is 0, except for administrators", () => {
    const off = makeServer({ backupLimit: 0 });
    expect(visibleServerTabs(off).map((t) => t.id)).not.toContain("backups");
    expect(resolveServerTab(off, "backups")).toBe("console");
    const admin = makeServer({
      backupLimit: 0,
      myPermissions: [...SERVER_OWNER_PERMISSIONS, "servers.admin"],
    });
    expect(visibleServerTabs(admin).map((t) => t.id)).toContain("backups");
  });

  it("hides Databases when the limit is 0, except for administrators, and without view permission", () => {
    const off = makeServer({ databaseLimit: 0 });
    expect(visibleServerTabs(off).map((t) => t.id)).not.toContain("databases");
    expect(resolveServerTab(off, "databases")).toBe("console");
    const admin = makeServer({
      databaseLimit: 0,
      myPermissions: [...SERVER_OWNER_PERMISSIONS, "servers.admin"],
    });
    expect(visibleServerTabs(admin).map((t) => t.id)).toContain("databases");
    expect(resolveServerTab(admin, "databases")).toBe("databases");
    const noView = makeServer({
      databaseLimit: 5,
      myPermissions: SERVER_OWNER_PERMISSIONS.filter((p) => p !== "servers.databases.view"),
    });
    expect(visibleServerTabs(noView).map((t) => t.id)).not.toContain("databases");
    const viewOnly = makeServer({ myPermissions: ["servers.view", "servers.databases.view"] });
    expect(visibleServerTabs(viewOnly).map((t) => t.id)).toEqual(["databases"]);
  });

  it("a console-only subuser sees just the console", () => {
    const s = makeServer({ myPermissions: ["servers.view", "servers.console.view"] });
    expect(visibleServerTabs(s).map((t) => t.id)).toEqual(["console"]);
    expect(resolveServerTab(s, "files")).toBe("console");
    expect(resolveServerTab(s, undefined)).toBe("console");
  });

  it("settings appears for SFTP-only access; nothing for view-only", () => {
    expect(
      visibleServerTabs(makeServer({ myPermissions: ["servers.view", "servers.files.sftp"] })).map(
        (t) => t.id,
      ),
    ).toEqual(["settings"]);
    const viewOnly = makeServer({ myPermissions: ["servers.view"] });
    expect(visibleServerTabs(viewOnly)).toEqual([]);
    expect(resolveServerTab(viewOnly, "console")).toBeNull();
  });

  it("suspension blocks actions unless the user is a server admin", () => {
    const suspended = makeServer({ suspended: true });
    expect(serverActionable(suspended, "servers.control")).toBe(false);
    const admin = makeServer({
      suspended: true,
      myPermissions: [...SERVER_OWNER_PERMISSIONS, "servers.admin"],
    });
    expect(serverActionable(admin, "servers.control")).toBe(true);
    expect(serverActionable(makeServer(), "servers.admin")).toBe(false);
  });
});

describe("power actions", () => {
  it("follow the lifecycle state machine", () => {
    const running = makeServer({ state: "running" });
    expect(powerActionState(running, "start").enabled).toBe(false);
    expect(powerActionState(running, "stop").enabled).toBe(true);
    expect(powerActionState(running, "kill").enabled).toBe(true);
    const stopped = makeServer({ state: "stopped" });
    expect(powerActionState(stopped, "start").enabled).toBe(true);
    expect(powerActionState(stopped, "restart").enabled).toBe(false);
    const busy = makeServer({ state: "running", activeOperation: "stop" });
    expect(powerActionState(busy, "restart")).toMatchObject({
      enabled: false,
      reason: expect.stringMatching(/stop/),
    });
    // kill may pre-empt a stuck stop
    expect(powerActionState(busy, "kill").enabled).toBe(true);
  });

  it("are disabled without servers.control and when suspended", () => {
    const noPower = makeServer({ myPermissions: ["servers.view", "servers.console.view"] });
    expect(powerActionState(noPower, "stop")).toMatchObject({
      enabled: false,
      reason: expect.stringMatching(/permission/),
    });
    expect(powerActionState(makeServer({ suspended: true }), "stop")).toMatchObject({
      enabled: false,
      reason: expect.stringMatching(/suspended/),
    });
  });

  it("asks for confirmation before killing", async () => {
    const fetchStub = vi.fn(
      async () =>
        new Response(JSON.stringify({ jobId: "77777777-7777-4777-8777-777777777777" }), { status: 202 }),
    );
    vi.stubGlobal("fetch", fetchStub);
    const qc = new QueryClient();
    const root = createRootRoute({ component: () => <PowerControls server={makeServer()} /> });
    const router = createRouter({ routeTree: root, history: createMemoryHistory({ initialEntries: ["/"] }) });
    render(
      <ThemeProvider>
        <QueryClientProvider client={qc}>
          <TooltipProvider>
            <RouterProvider router={router} />
          </TooltipProvider>
        </QueryClientProvider>
      </ThemeProvider>,
    );
    const kill = await screen.findByRole("button", { name: "Kill" });
    kill.click();
    const dialog = await screen.findByRole("alertdialog");
    expect(within(dialog).getByText(/terminated immediately/)).toBeTruthy();
    expect(fetchStub).not.toHaveBeenCalled();
  });
});

describe("subuser grants are a subset of the granter's permissions", () => {
  it("every assignable permission is in exactly one Pterodactyl-style group", () => {
    const grouped = SUBUSER_PERMISSION_GROUPS.flatMap((g) => g.permissions.map((p) => p.permission));
    expect(new Set(grouped).size).toBe(grouped.length);
    expect([...grouped].sort()).toEqual([...SUBUSER_ASSIGNABLE_PERMISSIONS].sort());
    expect(SUBUSER_PERMISSION_GROUPS.map((g) => g.id)).toEqual(
      expect.arrayContaining([
        "console",
        "power",
        "files",
        "backups",
        "allocations",
        "startup",
        "users",
        "schedules",
        "settings",
        "activity",
        "databases",
      ]),
    );
    expect(
      SUBUSER_PERMISSION_GROUPS.find((g) => g.id === "databases")!.permissions.map((p) => p.permission),
    ).toEqual([
      "servers.databases.view",
      "servers.databases.create",
      "servers.databases.update",
      "servers.databases.delete",
      "servers.databases.view_password",
    ]);
  });

  it("only offers what the granter holds", () => {
    const granter: Permission[] = [
      "servers.view",
      "servers.console.view",
      "servers.console.send",
      "servers.files.read",
      "servers.delete",
    ];
    const g = grantablePermissions(granter);
    expect([...g].sort()).toEqual([
      "servers.console.send",
      "servers.console.view",
      "servers.files.read",
      "servers.view",
    ]);
    // servers.delete is held but never assignable to subusers
    expect(g.has("servers.delete")).toBe(false);
  });

  it("drops permissions the granter lacks and always includes servers.view", () => {
    const granter: Permission[] = ["servers.console.view", "servers.control"];
    expect(
      normalizeGrant(["servers.console.view", "servers.files.write", "servers.delete"], granter),
    ).toEqual(["servers.view", "servers.console.view"]);
  });

  it("keeps a subuser's existing permissions the granter cannot change", () => {
    const granter: Permission[] = ["servers.console.view", "servers.subusers.manage"];
    const existing: Permission[] = ["servers.view", "servers.console.view", "servers.files.write"];
    // The granter un-ticks console.view (allowed) but cannot remove files.write (not theirs to manage).
    expect(normalizeGrant(["servers.view"], granter, existing)).toEqual([
      "servers.view",
      "servers.files.write",
    ]);
  });

  it("the matrix disables permissions the granter does not hold", () => {
    const granter: Permission[] = ["servers.view", "servers.console.view", "servers.subusers.manage"];
    render(
      <PermissionMatrix value={new Set(["servers.console.view"])} onChange={() => {}} granter={granter} />,
    );
    const view = screen.getByRole("checkbox", { name: /Read the live console/ });
    expect((view as HTMLButtonElement).disabled).toBe(false);
    const send = screen.getByRole("checkbox", { name: /^Send commands/ });
    expect((send as HTMLButtonElement).disabled).toBe(true);
    const power = screen.getByRole("checkbox", { name: /Start, stop, restart, kill/ });
    expect((power as HTMLButtonElement).disabled).toBe(true);
  });
});
