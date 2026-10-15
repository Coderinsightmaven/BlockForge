import { QueryClientProvider } from "@tanstack/react-query";
import type { QueryClient } from "@tanstack/react-query";
import { RouterProvider, createMemoryHistory, createRootRoute, createRouter } from "@tanstack/react-router";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { DatabaseHost } from "@blockforge/contracts";
import {
  DATABASE_HOST_ID,
  NODE_ID,
  apiErrorBody,
  jsonResponse,
  makeDatabaseHost,
  makeMe,
  makeNode,
} from "@/test/fixtures";
import { createQueryClient } from "@/lib/queries";
import { ThemeProvider } from "@/lib/theme";
import { TooltipProvider } from "@/components/ui/tooltip";
import { SidebarNav } from "@/components/shell/sidebar";
import {
  DatabaseHostsPage,
  PASSWORD_REQUIRED_MESSAGE,
  connectionChanged,
  formFromHost,
  hostRequest,
  testRequest,
} from "./database-hosts-page";

afterEach(() => vi.unstubAllGlobals());

type Call = { url: string; method: string; body: unknown };
type Reply = (call: Call) => Response | Promise<Response>;

function routeFetch(routes: Array<[method: string, path: RegExp, reply: Reply]>) {
  const calls: Call[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init: RequestInit = {}) => {
      const call: Call = {
        url,
        method: init.method ?? "GET",
        body: init.body ? JSON.parse(String(init.body)) : undefined,
      };
      calls.push(call);
      const route = routes.find(([m, p]) => m === call.method && p.test(url));
      return route ? route[2](call) : jsonResponse(apiErrorBody("NOT_FOUND"), { status: 404 });
    }),
  );
  return calls;
}
const ok =
  (body: unknown, status = 200) =>
  () =>
    jsonResponse(body, { status });

function wrap(ui: ReactNode): QueryClient {
  const qc = createQueryClient();
  render(
    <ThemeProvider>
      <QueryClientProvider client={qc}>
        <TooltipProvider>{ui}</TooltipProvider>
      </QueryClientProvider>
    </ThemeProvider>,
  );
  return qc;
}

const admin = makeMe({ permissions: ["database_hosts.manage", "nodes.view"] });
const HOSTS = /\/database-hosts$/;
const SECRET = "Adm1n-S3cret!";
const saved = makeDatabaseHost();
const OTHER_ID = "bbbbbbbb-bbbb-4bbb-8bbb-000000000002";

function cacheDump(qc: QueryClient): string {
  return JSON.stringify([
    qc
      .getQueryCache()
      .getAll()
      .map((q) => q.state.data),
    qc
      .getMutationCache()
      .getAll()
      .map((m) => [m.state.data, m.state.variables]),
  ]);
}

// -------------------------------------------------------------------------------------------------

describe("database host form model", () => {
  it("never prefills the password and flags connection changes", () => {
    const f = formFromHost(saved);
    expect(f.password).toBe("");
    expect(f.port).toBe("3306");
    expect(f.maxDatabases).toBe("50");
    expect(connectionChanged(f, saved)).toBe(false);
    expect(connectionChanged({ ...f, name: "x", notes: "y", publicHost: "", maxDatabases: "" }, saved)).toBe(
      false,
    );
    expect(connectionChanged({ ...f, host: "10.0.0.6" }, saved)).toBe(true);
    expect(connectionChanged({ ...f, port: "3307" }, saved)).toBe(true);
    expect(connectionChanged({ ...f, username: "root" }, saved)).toBe(true);
    expect(connectionChanged({ ...f, tlsMode: "required" }, saved)).toBe(true);
    expect(
      connectionChanged(
        { ...f, tlsCaCertificate: "-----BEGIN CERTIFICATE-----\nx\n-----END CERTIFICATE-----" },
        saved,
      ),
    ).toBe(true);
  });

  it("create needs the password and sends every field", () => {
    const f = { ...formFromHost(null), name: "mysql-1", host: "db.internal", username: "admin" };
    expect(hostRequest(f, null).errors).toEqual({ password: "Enter the admin password." });
    const r = hostRequest({ ...f, password: SECRET, maxDatabases: "20", nodeId: NODE_ID }, null);
    expect(r).toEqual({
      kind: "create",
      errors: {},
      body: {
        name: "mysql-1",
        host: "db.internal",
        port: 3306,
        publicHost: null,
        username: "admin",
        password: SECRET,
        nodeId: NODE_ID,
        maxDatabases: 20,
        tlsMode: "preferred",
        tlsCaCertificate: null,
        notes: "",
      },
    });
  });

  it("edit sends only changed fields; the password only when typed, required for connection changes", () => {
    const f = formFromHost(saved);
    expect(hostRequest({ ...f, name: "renamed", maxDatabases: "" }, saved)).toEqual({
      kind: "update",
      errors: {},
      body: { name: "renamed", maxDatabases: null },
    });
    expect(hostRequest({ ...f, tlsMode: "required" }, saved).errors).toEqual({
      password: PASSWORD_REQUIRED_MESSAGE,
    });
    expect(hostRequest({ ...f, host: "10.0.0.6", password: SECRET }, saved)).toEqual({
      kind: "update",
      errors: {},
      body: { host: "10.0.0.6", password: SECRET },
    });
    expect(hostRequest({ ...f, port: "70000", host: "bad host!" }, saved).errors).toMatchObject({
      port: "A port from 1 to 65535.",
      host: expect.stringMatching(/host name or IP/),
      password: PASSWORD_REQUIRED_MESSAGE,
    });
    expect(hostRequest({ ...f, tlsCaCertificate: "not a pem" }, saved).errors).toMatchObject({
      tlsCaCertificate: expect.stringMatching(/PEM/),
    });
  });

  it("tests unsaved values with the stored password only while the connection is unchanged", () => {
    const f = formFromHost(saved);
    expect(testRequest(f, saved)).toEqual({
      errors: {},
      body: {
        host: "10.0.0.5",
        port: 3306,
        username: "blockforge",
        hostId: DATABASE_HOST_ID,
        tlsMode: "preferred",
        tlsCaCertificate: null,
      },
    });
    expect(testRequest({ ...f, username: "root" }, saved)).toEqual({
      body: null,
      errors: { password: PASSWORD_REQUIRED_MESSAGE },
    });
    expect(testRequest({ ...f, username: "root", password: SECRET }, saved).body).toMatchObject({
      username: "root",
      password: SECRET,
    });
    expect(testRequest({ ...f, username: "root", password: SECRET }, saved).body).not.toHaveProperty(
      "hostId",
    );
    expect(testRequest(formFromHost(null), null).errors).toMatchObject({
      password: "Enter the admin password.",
    });
  });
});

// -------------------------------------------------------------------------------------------------

describe("Database hosts page", () => {
  it("requires database_hosts.manage", () => {
    const calls = routeFetch([]);
    wrap(<DatabaseHostsPage me={makeMe({ permissions: ["nodes.view"] })} />);
    expect(screen.getByText("You don't have access")).toBeTruthy();
    expect(calls).toHaveLength(0);
  });

  it("lists hosts with address, public address, node, usage, TLS and notes (as text)", async () => {
    routeFetch([
      [
        "GET",
        HOSTS,
        ok([
          makeDatabaseHost({ notes: '<img src=x onerror="alert(1)"> rack 4' }),
          makeDatabaseHost({
            id: OTHER_ID,
            name: "mysql-v6",
            host: "2001:db8::5",
            publicHost: null,
            nodeId: null,
            nodeName: null,
            maxDatabases: null,
            databaseCount: 0,
            tlsMode: "required",
            tlsCaCertificate: "-----BEGIN CERTIFICATE-----\nabc\n-----END CERTIFICATE-----",
          }),
        ]),
      ],
    ]);
    wrap(<DatabaseHostsPage me={admin} />);
    const row = (await screen.findByText("mysql-fra")).closest("tr")!;
    expect(within(row).getByText("10.0.0.5:3306")).toBeTruthy();
    expect(within(row).getByText("as blockforge")).toBeTruthy();
    expect(within(row).getByText("db.example.test")).toBeTruthy();
    expect(within(row).getByText("fra-1")).toBeTruthy();
    expect(within(row).getByText("3 / 50")).toBeTruthy();
    expect(within(row).getByText("Preferred")).toBeTruthy();
    expect(within(row).getByText('<img src=x onerror="alert(1)"> rack 4')).toBeTruthy();
    expect(row.querySelector("img")).toBeNull();
    // Hosts that still hold databases cannot be deleted.
    expect(
      (within(row).getByRole("button", { name: "Delete mysql-fra" }) as HTMLButtonElement).disabled,
    ).toBe(true);
    const v6 = screen.getByText("mysql-v6").closest("tr")!;
    expect(within(v6).getByText("[2001:db8::5]:3306")).toBeTruthy();
    expect(within(v6).getByText("Same")).toBeTruthy();
    expect(within(v6).getByText("0 / unlimited")).toBeTruthy();
    expect(within(v6).getByText("Required · CA verified")).toBeTruthy();
    // No password anywhere.
    expect(document.body.textContent).not.toMatch(/password/i);
  });

  it("creates a host: the password is required, sent once and kept out of every cache", async () => {
    let hosts: DatabaseHost[] = [];
    const calls = routeFetch([
      ["GET", HOSTS, () => jsonResponse(hosts)],
      ["GET", /\/nodes$/, ok([makeNode()])],
      [
        "POST",
        HOSTS,
        () => {
          hosts = [makeDatabaseHost({ name: "mysql-new" })];
          return jsonResponse(hosts[0], { status: 201 });
        },
      ],
    ]);
    const user = userEvent.setup();
    const qc = wrap(<DatabaseHostsPage me={admin} />);
    expect(await screen.findByText("No database hosts")).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "Add database host" }));
    const dialog = await screen.findByRole("dialog");
    expect((within(dialog).getByLabelText(/^Port/) as HTMLInputElement).value).toBe("3306");
    await user.type(within(dialog).getByLabelText(/^Name/), "mysql-new");
    await user.type(within(dialog).getByLabelText(/^Host/), "db.internal");
    await user.type(within(dialog).getByLabelText(/^Admin username/), "admin");
    await user.click(within(dialog).getByRole("button", { name: "Add host" }));
    expect(within(dialog).getByText("Enter the admin password.")).toBeTruthy();
    expect(calls.some((c) => c.method === "POST")).toBe(false);

    await user.type(within(dialog).getByLabelText(/^Admin password/), SECRET);
    await user.type(within(dialog).getByLabelText(/^Max databases/), "25");
    within(dialog).getByRole("combobox", { name: "TLS" }).focus();
    await user.keyboard("{Enter}");
    await user.click(await screen.findByRole("option", { name: "Required" }));
    expect(within(dialog).getByText(/Always encrypted, or the connection fails/)).toBeTruthy();
    await user.click(within(dialog).getByRole("button", { name: "Add host" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(calls.find((c) => c.method === "POST")!.body).toEqual({
      name: "mysql-new",
      host: "db.internal",
      port: 3306,
      publicHost: null,
      username: "admin",
      password: SECRET,
      nodeId: null,
      maxDatabases: 25,
      tlsMode: "required",
      tlsCaCertificate: null,
      notes: "",
    });
    expect(await screen.findByText("mysql-new")).toBeTruthy();
    await waitFor(() => expect(cacheDump(qc)).not.toContain(SECRET));
    expect(document.body.textContent).not.toContain(SECRET);
  });

  it("edits without the password when only the name changes; never prefills it", async () => {
    const calls = routeFetch([
      ["GET", HOSTS, ok([saved])],
      ["GET", /\/nodes$/, ok([makeNode()])],
      ["PATCH", /\/database-hosts\/[^/]+$/, ok(makeDatabaseHost({ name: "renamed" }))],
    ]);
    const user = userEvent.setup();
    wrap(<DatabaseHostsPage me={admin} />);
    await user.click(await screen.findByRole("button", { name: "Edit mysql-fra" }));
    const dialog = await screen.findByRole("dialog");
    const password = within(dialog).getByLabelText(/^Admin password/) as HTMLInputElement;
    expect(password.value).toBe("");
    expect(password.type).toBe("password");
    expect(within(dialog).getByText(/Leave empty to keep the stored password/)).toBeTruthy();
    const name = within(dialog).getByLabelText(/^Name/);
    await user.clear(name);
    await user.type(name, "renamed");
    await user.click(within(dialog).getByRole("button", { name: "Save" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    const patch = calls.find((c) => c.method === "PATCH")!;
    expect(patch.url).toBe(`/api/v1/database-hosts/${DATABASE_HOST_ID}`);
    expect(patch.body).toEqual({ name: "renamed" });
  });

  it("changing the address requires re-entering the password; the API's password error shows on the field", async () => {
    const calls = routeFetch([
      ["GET", HOSTS, ok([saved])],
      ["GET", /\/nodes$/, ok([makeNode()])],
      [
        "PATCH",
        /\/database-hosts\/[^/]+$/,
        () =>
          jsonResponse(
            apiErrorBody("VALIDATION_FAILED", "invalid", "req-9", {
              issues: [{ path: "password", message: "Wrong password for this host" }],
            }),
            { status: 400 },
          ),
      ],
    ]);
    const user = userEvent.setup();
    wrap(<DatabaseHostsPage me={admin} />);
    await user.click(await screen.findByRole("button", { name: "Edit mysql-fra" }));
    const dialog = await screen.findByRole("dialog");
    const host = within(dialog).getByLabelText(/^Host/);
    await user.clear(host);
    await user.type(host, "10.0.0.9");
    // The hint switches as soon as a connection setting differs.
    expect(within(dialog).getAllByText(PASSWORD_REQUIRED_MESSAGE).length).toBeGreaterThan(0);
    await user.click(within(dialog).getByRole("button", { name: "Save" }));
    expect(calls.some((c) => c.method === "PATCH")).toBe(false);
    const password = within(dialog).getByLabelText(/^Admin password/);
    expect(password.getAttribute("aria-invalid")).toBe("true");
    // Testing the changed settings needs it too.
    await user.click(within(dialog).getByRole("button", { name: "Test connection" }));
    expect(calls.some((c) => c.url.endsWith("/database-hosts/test"))).toBe(false);

    await user.type(password, SECRET);
    await user.click(within(dialog).getByRole("button", { name: "Save" }));
    expect(await within(dialog).findByText("Wrong password for this host")).toBeTruthy();
    expect(calls.find((c) => c.method === "PATCH")!.body).toEqual({ host: "10.0.0.9", password: SECRET });
  });

  it("tests the form with the stored password (hostId) and shows version, TLS and latency", async () => {
    const calls = routeFetch([
      ["GET", HOSTS, ok([saved])],
      ["GET", /\/nodes$/, ok([makeNode()])],
      [
        "POST",
        /\/database-hosts\/test$/,
        ok({ ok: true, error: null, serverVersion: "8.0.36", tls: true, latencyMs: 4 }),
      ],
    ]);
    const user = userEvent.setup();
    wrap(<DatabaseHostsPage me={admin} />);
    await user.click(await screen.findByRole("button", { name: "Edit mysql-fra" }));
    const dialog = await screen.findByRole("dialog");
    await user.click(within(dialog).getByRole("button", { name: "Test connection" }));
    const result = await within(dialog).findByRole("status");
    expect(result.textContent).toContain("Connection works");
    expect(result.textContent).toContain("Server 8.0.36 · TLS on · 4 ms");
    expect(calls.find((c) => c.url.endsWith("/database-hosts/test"))!.body).toEqual({
      host: "10.0.0.5",
      port: 3306,
      username: "blockforge",
      hostId: DATABASE_HOST_ID,
      tlsMode: "preferred",
      tlsCaCertificate: null,
    });
    // Any change makes the result stale.
    await user.type(within(dialog).getByLabelText(/^Notes/), "x");
    expect(within(dialog).queryByText("Connection works")).toBeNull();
  });

  it("tests a saved host from its row and shows a failure", async () => {
    const calls = routeFetch([
      ["GET", HOSTS, ok([saved])],
      [
        "POST",
        /\/database-hosts\/[^/]+\/test$/,
        ok({ ok: false, error: "Access denied for user", serverVersion: null, tls: false, latencyMs: 12 }),
      ],
    ]);
    const user = userEvent.setup();
    wrap(<DatabaseHostsPage me={admin} />);
    await user.click(await screen.findByRole("button", { name: "Test mysql-fra" }));
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("Connection failed");
    expect(alert.textContent).toContain("Access denied for user");
    expect(alert.textContent).toContain("TLS off (not encrypted) · 12 ms");
    expect(calls.find((c) => c.method === "POST")!.url).toBe(
      `/api/v1/database-hosts/${DATABASE_HOST_ID}/test`,
    );
    await user.click(screen.getByRole("button", { name: "Dismiss test result" }));
    expect(screen.queryByText("Connection failed")).toBeNull();
  });

  it("explains a refused delete (409 has_databases)", async () => {
    const calls = routeFetch([
      ["GET", HOSTS, ok([makeDatabaseHost({ databaseCount: 0 })])],
      [
        "DELETE",
        /\/database-hosts\/[^/]+$/,
        () =>
          jsonResponse(apiErrorBody("CONFLICT", "conflict", "req-3", { reason: "has_databases", count: 2 }), {
            status: 409,
          }),
      ],
    ]);
    const user = userEvent.setup();
    wrap(<DatabaseHostsPage me={admin} />);
    await user.click(await screen.findByRole("button", { name: "Delete mysql-fra" }));
    const confirm = await screen.findByRole("alertdialog");
    await user.click(within(confirm).getByRole("button", { name: "Delete host" }));
    expect((await within(confirm).findByRole("alert")).textContent).toMatch(/still holds 2 databases/);
    expect(calls.filter((c) => c.method === "DELETE")).toHaveLength(1);
  });
});

describe("Database hosts navigation", () => {
  function renderNav(permissions: Parameters<typeof makeMe>[0]) {
    routeFetch([]);
    const root = createRootRoute({ component: () => <SidebarNav me={makeMe(permissions)} /> });
    const router = createRouter({ routeTree: root, history: createMemoryHistory({ initialEntries: ["/"] }) });
    wrap(<RouterProvider router={router} />);
  }

  it("is listed under Administration for global database_hosts.manage holders only", async () => {
    renderNav({ permissions: ["database_hosts.manage"] });
    const link = await screen.findByRole("link", { name: /Database hosts/ });
    expect(link.getAttribute("href")).toBe("/admin/database-hosts");
  });

  it("is hidden otherwise", async () => {
    renderNav({ permissions: ["monitoring.view", "templates.view"] });
    expect(await screen.findByRole("link", { name: /Templates/ })).toBeTruthy();
    expect(screen.queryByRole("link", { name: /Database hosts/ })).toBeNull();
  });
});
