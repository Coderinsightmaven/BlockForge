import { QueryClientProvider } from "@tanstack/react-query";
import type { QueryClient } from "@tanstack/react-query";
import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";
import { toast } from "sonner";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SERVER_OWNER_PERMISSIONS } from "@blockforge/contracts";
import type { Permission, ServerDatabaseStatus } from "@blockforge/contracts";
import {
  DATABASE_HOST_ID,
  DATABASE_ID,
  SERVER_ID,
  apiErrorBody,
  jsonResponse,
  makeDatabaseHost,
  makeMe,
  makeServer,
  makeServerDatabase,
} from "@/test/fixtures";
import { createQueryClient } from "@/lib/queries";
import { qk } from "@/lib/query-keys";
import { ThemeProvider } from "@/lib/theme";
import { TooltipProvider } from "@/components/ui/tooltip";
import { UNKNOWN_OUTCOME_MESSAGE } from "@/lib/databases";
import DatabasesTab, { CLEANUP_PENDING_HINT, DATABASE_STATUS_META, remoteHint } from "./databases-tab";

afterEach(() => vi.unstubAllGlobals());

type Call = { url: string; method: string; body: unknown };
type Reply = (call: Call) => Response | Promise<Response>;

/** Fetch stub routed by method + path; unknown routes answer 404. */
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
const fail =
  (status: number, code: string, details?: unknown, message = "refused") =>
  () =>
    jsonResponse(apiErrorBody(code, message, "req-db", details), { status });

function wrap(ui: ReactNode): QueryClient {
  // The app's client: mutation entries are dropped as soon as nothing observes them.
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

const owner = [...SERVER_OWNER_PERMISSIONS] as Permission[];
const adminPerms = [...owner, "servers.admin"] as Permission[];
const LIST = /\/servers\/[^/]+\/databases$/;
const PASSWORD = "p@ss:w/rd#1 x";

function cacheDump(qc: QueryClient): string {
  return JSON.stringify([
    qc
      .getQueryCache()
      .getAll()
      .map((q) => [q.queryKey, q.state.data]),
    qc
      .getMutationCache()
      .getAll()
      .map((m) => [m.state.data, m.state.variables]),
  ]);
}

describe("Databases tab: list", () => {
  it("shows name, address, user, connections from, usage; IPv6 hosts are bracketed", async () => {
    routeFetch([
      [
        "GET",
        LIST,
        ok([
          makeServerDatabase(),
          makeServerDatabase({
            id: "aaaaaaaa-aaaa-4aaa-8aaa-000000000002",
            database: "s55555555_coreprotect",
            username: "u55555555_zzzzzzzzzz",
            host: "2001:db8::10",
            port: 3307,
            remote: "10.0.0.0/255.0.0.0",
            passwordRotatedAt: 1_760_000_100_000,
          }),
        ]),
      ],
    ]);
    wrap(<DatabasesTab server={makeServer({ databaseLimit: 3 })} me={makeMe()} />);
    const row = (await screen.findByText("s55555555_luckperms")).closest("tr")!;
    expect(within(row).getByText("db.example.test:3306")).toBeTruthy();
    expect(within(row).getByText("u55555555_k3j9x0q2ab")).toBeTruthy();
    expect(within(row).getByText("(anywhere)")).toBeTruthy();
    expect(within(row).getByText("on mysql-fra")).toBeTruthy();
    const v6 = screen.getByText("s55555555_coreprotect").closest("tr")!;
    expect(within(v6).getByText("[2001:db8::10]:3307")).toBeTruthy();
    expect(within(v6).getByText("10.0.0.0/255.0.0.0")).toBeTruthy();
    expect(within(v6).getByText(/password rotated/)).toBeTruthy();
    expect(screen.getByText("2 / 3 used")).toBeTruthy();
    // No password is ever requested for the list.
    expect(screen.queryByText(PASSWORD)).toBeNull();
  });

  it("shows an empty state, and administrators see that the limit does not bind them", async () => {
    routeFetch([["GET", LIST, ok([])]]);
    wrap(<DatabasesTab server={makeServer({ myPermissions: adminPerms })} me={makeMe()} />);
    expect(await screen.findByText("No databases yet")).toBeTruthy();
    expect(screen.getByText("0 / 2 used · not enforced for administrators")).toBeTruthy();
  });

  it("at the limit, non-administrators cannot create", async () => {
    routeFetch([["GET", LIST, ok([makeServerDatabase()])]]);
    wrap(<DatabasesTab server={makeServer({ databaseLimit: 1 })} me={makeMe()} />);
    expect(await screen.findByText("1 / 1 used")).toBeTruthy();
    expect((screen.getByRole("button", { name: "Create database" }) as HTMLButtonElement).disabled).toBe(
      true,
    );
  });

  it("at the limit, administrators can still create (with a note)", async () => {
    routeFetch([["GET", LIST, ok([makeServerDatabase()])]]);
    const user = userEvent.setup();
    wrap(<DatabasesTab server={makeServer({ databaseLimit: 1, myPermissions: adminPerms })} me={makeMe()} />);
    await screen.findByText("s55555555_luckperms");
    const adminCreate = screen.getByRole("button", { name: "Create database" }) as HTMLButtonElement;
    expect(adminCreate.disabled).toBe(false);
    await user.click(adminCreate);
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByText(/As an administrator you can still create databases/)).toBeTruthy();
  });

  it("limit 0: explains that databases are disabled (shown to administrators only)", async () => {
    routeFetch([["GET", LIST, ok([])]]);
    wrap(<DatabasesTab server={makeServer({ databaseLimit: 0, myPermissions: adminPerms })} me={makeMe()} />);
    expect(await screen.findByText("Databases are disabled for this server")).toBeTruthy();
    expect((screen.getByRole("button", { name: "Create database" }) as HTMLButtonElement).disabled).toBe(
      false,
    );
  });

  it("suspended servers: no create or delete for non-administrators", async () => {
    routeFetch([["GET", LIST, ok([makeServerDatabase()])]]);
    wrap(<DatabasesTab server={makeServer({ suspended: true })} me={makeMe()} />);
    await screen.findByText("s55555555_luckperms");
    expect((screen.getByRole("button", { name: "Create database" }) as HTMLButtonElement).disabled).toBe(
      true,
    );
    expect(screen.queryByRole("button", { name: "Delete s55555555_luckperms" })).toBeNull();
  });

  it("view-only users get the list and connection details, but no create or delete", async () => {
    routeFetch([["GET", LIST, ok([makeServerDatabase()])]]);
    wrap(
      <DatabasesTab
        server={makeServer({ myPermissions: ["servers.view", "servers.databases.view"] })}
        me={makeMe()}
      />,
    );
    await screen.findByText("s55555555_luckperms");
    expect(screen.queryByRole("button", { name: "Create database" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Delete s55555555_luckperms" })).toBeNull();
    expect(screen.getByRole("button", { name: "Connection details for s55555555_luckperms" })).toBeTruthy();
  });
});

describe("Databases tab: create", () => {
  it("shows the fixed prefix, validates name and connections-from, normalises CIDR, sends the body", async () => {
    const created = makeServerDatabase({ database: "s55555555_shop_db", remote: "10.0.0.0/255.0.0.0" });
    let rows: unknown[] = [];
    const calls = routeFetch([
      ["GET", LIST, () => jsonResponse(rows)],
      [
        "POST",
        LIST,
        () => {
          rows = [created];
          return jsonResponse(created, { status: 201 });
        },
      ],
    ]);
    const user = userEvent.setup();
    wrap(<DatabasesTab server={makeServer()} me={makeMe()} />);
    await screen.findByText("No databases yet");
    await user.click(screen.getByRole("button", { name: "Create database" }));
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByText("s55555555_")).toBeTruthy();
    // No host picker without database_hosts.manage.
    expect(within(dialog).queryByLabelText("Database host")).toBeNull();

    const name = within(dialog).getByLabelText(/^Database name/) as HTMLInputElement;
    expect(name.maxLength).toBe(48);
    await user.type(name, "Shop-DB");
    const remote = within(dialog).getByLabelText("Connections from") as HTMLInputElement;
    expect(remote.value).toBe("%");
    await user.clear(remote);
    await user.type(remote, "10.0.0.0/33");
    await user.click(within(dialog).getByRole("button", { name: "Create database" }));
    expect(within(dialog).getByText("Use 1–48 lowercase letters, digits or underscores")).toBeTruthy();
    expect(within(dialog).getByText(/^Use %, an IPv4 address/)).toBeTruthy();
    expect(calls.filter((c) => c.method === "POST")).toHaveLength(0);

    await user.clear(name);
    await user.type(name, "shop_db");
    expect(within(dialog).getByText(/Full name: s55555555_shop_db/)).toBeTruthy();
    await user.clear(remote);
    await user.type(remote, "10.0.0.0/8");
    expect(within(dialog).getByText(/Saved as 10\.0\.0\.0\/255\.0\.0\.0\./)).toBeTruthy();
    await user.click(within(dialog).getByRole("button", { name: "Create database" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(calls.find((c) => c.method === "POST")!.body).toEqual({
      name: "shop_db",
      remote: "10.0.0.0/255.0.0.0",
    });
    expect(await screen.findByText("s55555555_shop_db")).toBeTruthy();
  });

  it.each([
    [409, "CONFLICT", { reason: "limit_reached", limit: 2 }, /reached its limit of 2 databases/],
    [422, "VALIDATION_FAILED", { reason: "no_host" }, /No database host has room/],
    [
      403,
      "FORBIDDEN",
      { reason: "disabled" },
      /Databases are disabled for this server \(its database limit is 0\)/,
    ],
    [409, "CONFLICT", { reason: "host_full" }, /selected database host has no room/],
    [
      502,
      "UPSTREAM_ERROR",
      { reason: "host_error", code: "ER_ACCESS_DENIED_ERROR" },
      /\(error ER_ACCESS_DENIED_ERROR\)/,
    ],
    [409, "CONFLICT", { reason: "busy" }, /Another operation on this database is still in progress/],
  ])("maps HTTP %i %s %o to a clear message", async (status, code, details, message) => {
    routeFetch([
      ["GET", LIST, ok([])],
      ["POST", LIST, fail(status, code, details)],
    ]);
    const user = userEvent.setup();
    wrap(<DatabasesTab server={makeServer()} me={makeMe()} />);
    await screen.findByText("No databases yet");
    await user.click(screen.getByRole("button", { name: "Create database" }));
    const dialog = await screen.findByRole("dialog");
    await user.type(within(dialog).getByLabelText(/^Database name/), "stats");
    await user.click(within(dialog).getByRole("button", { name: "Create database" }));
    expect((await within(dialog).findByRole("alert")).textContent).toMatch(message);
  });

  it("name_taken is shown on the name field", async () => {
    routeFetch([
      ["GET", LIST, ok([])],
      ["POST", LIST, fail(409, "CONFLICT", { reason: "name_taken" })],
    ]);
    const user = userEvent.setup();
    wrap(<DatabasesTab server={makeServer()} me={makeMe()} />);
    await screen.findByText("No databases yet");
    await user.click(screen.getByRole("button", { name: "Create database" }));
    const dialog = await screen.findByRole("dialog");
    const name = within(dialog).getByLabelText(/^Database name/);
    await user.type(name, "stats");
    await user.click(within(dialog).getByRole("button", { name: "Create database" }));
    expect(await within(dialog).findByText(/already has a database with this name/)).toBeTruthy();
    expect(name.getAttribute("aria-invalid")).toBe("true");
  });

  it("database host administrators can pick a host (default Automatic)", async () => {
    const full = makeDatabaseHost({
      id: "bbbbbbbb-bbbb-4bbb-8bbb-000000000002",
      name: "mysql-full",
      maxDatabases: 3,
      databaseCount: 3,
    });
    const calls = routeFetch([
      ["GET", LIST, ok([])],
      ["GET", /\/database-hosts$/, ok([makeDatabaseHost(), full])],
      ["POST", LIST, ok(makeServerDatabase(), 201)],
    ]);
    const user = userEvent.setup();
    wrap(<DatabasesTab server={makeServer()} me={makeMe({ permissions: ["database_hosts.manage"] })} />);
    await screen.findByText("No databases yet");
    await user.click(screen.getByRole("button", { name: "Create database" }));
    const dialog = await screen.findByRole("dialog");
    const picker = within(dialog).getByRole("combobox", { name: "Database host" });
    expect(picker.textContent).toContain("Automatic");
    await waitFor(() => expect(calls.some((c) => c.url.endsWith("/database-hosts"))).toBe(true));
    picker.focus();
    await user.keyboard("{Enter}");
    const fullOption = await screen.findByRole("option", { name: /mysql-full/ });
    expect(fullOption.getAttribute("aria-disabled")).toBe("true");
    await user.click(screen.getByRole("option", { name: /mysql-fra — 10\.0\.0\.5:3306 \(3 \/ 50\)/ }));
    await user.type(within(dialog).getByLabelText(/^Database name/), "luckperms");
    await user.click(within(dialog).getByRole("button", { name: "Create database" }));
    await waitFor(() => expect(calls.some((c) => c.method === "POST")).toBe(true));
    expect(calls.find((c) => c.method === "POST")!.body).toEqual({
      name: "luckperms",
      remote: "%",
      hostId: DATABASE_HOST_ID,
    });
  });
});

describe("Databases tab: connection details", () => {
  const detailsServer = (perms: Permission[] = owner) => makeServer({ myPermissions: perms });

  it("reveals the password only on click, keeps it out of every cache, and hides it again", async () => {
    const calls = routeFetch([
      ["GET", LIST, ok([makeServerDatabase()])],
      ["GET", /\/password$/, ok({ password: PASSWORD })],
    ]);
    const user = userEvent.setup();
    const qc = wrap(<DatabasesTab server={detailsServer()} me={makeMe()} />);
    await user.click(
      await screen.findByRole("button", { name: "Connection details for s55555555_luckperms" }),
    );
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByLabelText("JDBC URL").textContent).toBe(
      "jdbc:mysql://db.example.test:3306/s55555555_luckperms",
    );
    expect(within(dialog).getByLabelText("Username").textContent).toBe("u55555555_k3j9x0q2ab");
    expect(within(dialog).queryByLabelText("Connection string")).toBeNull();
    expect(calls.filter((c) => c.url.includes("/password"))).toHaveLength(0);

    await user.click(within(dialog).getByRole("button", { name: "Show password" }));
    expect((await within(dialog).findByLabelText("Password")).textContent).toBe(PASSWORD);
    expect(calls.filter((c) => c.url.includes("/password"))).toHaveLength(1);
    expect(calls.find((c) => c.url.includes("/password"))!.url).toContain(
      `/databases/${DATABASE_ID}/password`,
    );
    expect(within(dialog).getByLabelText("Connection string").textContent).toBe(
      "mysql://u55555555_k3j9x0q2ab:p%40ss%3Aw%2Frd%231%20x@db.example.test:3306/s55555555_luckperms",
    );
    expect(within(dialog).getByRole("button", { name: "Copy password" })).toBeTruthy();
    await waitFor(() => expect(cacheDump(qc)).not.toContain("p@ss"));
    expect(JSON.stringify({ ...localStorage, ...sessionStorage })).not.toContain("p@ss");

    await user.click(within(dialog).getByRole("button", { name: "Hide password" }));
    expect(document.body.textContent).not.toContain(PASSWORD);
    expect(within(dialog).queryByLabelText("Connection string")).toBeNull();
    // Showing it again asks the API again (nothing was kept).
    await user.click(within(dialog).getByRole("button", { name: "Show password" }));
    await within(dialog).findByLabelText("Password");
    expect(calls.filter((c) => c.url.includes("/password"))).toHaveLength(2);
    // Closing the dialog drops it too.
    await user.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(document.body.textContent).not.toContain(PASSWORD);
  });

  it("a rotation made elsewhere (seen on the next list read) drops a revealed password", async () => {
    let rows = [makeServerDatabase()];
    routeFetch([
      ["GET", LIST, () => jsonResponse(rows)],
      ["GET", /\/password$/, ok({ password: PASSWORD })],
    ]);
    const user = userEvent.setup();
    const qc = wrap(<DatabasesTab server={detailsServer()} me={makeMe()} />);
    await user.click(
      await screen.findByRole("button", { name: "Connection details for s55555555_luckperms" }),
    );
    const dialog = await screen.findByRole("dialog");
    await user.click(within(dialog).getByRole("button", { name: "Show password" }));
    await within(dialog).findByLabelText("Password");
    rows = [makeServerDatabase({ passwordRotatedAt: 1_760_000_900_000 })];
    await act(() => qc.invalidateQueries({ queryKey: qk.server(SERVER_ID).databases }));
    await waitFor(() => expect(document.body.textContent).not.toContain(PASSWORD));
    expect(screen.getByRole("dialog")).toBeTruthy();
    expect(within(screen.getByRole("dialog")).getByRole("button", { name: "Show password" })).toBeTruthy();
  });

  it("without view_password there is no reveal button", async () => {
    const calls = routeFetch([["GET", LIST, ok([makeServerDatabase()])]]);
    const user = userEvent.setup();
    wrap(
      <DatabasesTab
        server={detailsServer(owner.filter((p) => p !== "servers.databases.view_password"))}
        me={makeMe()}
      />,
    );
    await user.click(
      await screen.findByRole("button", { name: "Connection details for s55555555_luckperms" }),
    );
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).queryByRole("button", { name: "Show password" })).toBeNull();
    expect(within(dialog).getByText(/needs the “View passwords” permission/)).toBeTruthy();
    expect(calls.some((c) => c.url.includes("/password"))).toBe(false);
  });

  it("rotating asks first, then clears a revealed password", async () => {
    const rotated = makeServerDatabase({ passwordRotatedAt: 1_760_000_500_000 });
    let rows = [makeServerDatabase()];
    const calls = routeFetch([
      ["GET", LIST, () => jsonResponse(rows)],
      ["GET", /\/password$/, ok({ password: PASSWORD })],
      [
        "POST",
        /\/rotate-password$/,
        () => {
          rows = [rotated];
          return jsonResponse(rotated);
        },
      ],
    ]);
    const user = userEvent.setup();
    wrap(<DatabasesTab server={detailsServer()} me={makeMe()} />);
    await user.click(
      await screen.findByRole("button", { name: "Connection details for s55555555_luckperms" }),
    );
    const dialog = await screen.findByRole("dialog");
    await user.click(within(dialog).getByRole("button", { name: "Show password" }));
    await within(dialog).findByLabelText("Password");

    await user.click(within(dialog).getByRole("button", { name: "Rotate password" }));
    const confirm = await screen.findByRole("alertdialog");
    expect(within(confirm).getByText(/Applications using the old password will lose access/)).toBeTruthy();
    expect(calls.some((c) => c.url.includes("rotate-password"))).toBe(false);
    await user.click(within(confirm).getByRole("button", { name: "Rotate password" }));
    await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
    expect(calls.filter((c) => c.method === "POST" && c.url.includes("rotate-password"))).toHaveLength(1);
    expect(document.body.textContent).not.toContain(PASSWORD);
    expect(within(dialog).getByRole("button", { name: "Show password" })).toBeTruthy();
    expect(await within(dialog).findByText(/Password last rotated/)).toBeTruthy();
  });

  it("no rotate button without servers.databases.update", async () => {
    routeFetch([["GET", LIST, ok([makeServerDatabase()])]]);
    const user = userEvent.setup();
    wrap(
      <DatabasesTab
        server={detailsServer(owner.filter((p) => p !== "servers.databases.update"))}
        me={makeMe()}
      />,
    );
    await user.click(
      await screen.findByRole("button", { name: "Connection details for s55555555_luckperms" }),
    );
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).queryByRole("button", { name: "Rotate password" })).toBeNull();
  });
});

describe("Databases tab: delete", () => {
  it("sends DELETE only after the full database name is typed", async () => {
    const calls = routeFetch([
      ["GET", LIST, ok([makeServerDatabase()])],
      ["DELETE", /\/databases\/[^/]+$/, () => new Response(null, { status: 204 })],
    ]);
    const user = userEvent.setup();
    wrap(<DatabasesTab server={makeServer()} me={makeMe()} />);
    await user.click(await screen.findByRole("button", { name: "Delete s55555555_luckperms" }));
    const confirm = await screen.findByRole("alertdialog");
    const button = within(confirm).getByRole("button", { name: "Delete database" }) as HTMLButtonElement;
    expect(button.disabled).toBe(true);
    const input = within(confirm).getByLabelText(/to confirm/);
    await user.type(input, "luckperms");
    expect(button.disabled).toBe(true);
    await user.clear(input);
    await user.type(input, "s55555555_luckperms");
    expect(button.disabled).toBe(false);
    expect(calls.some((c) => c.method === "DELETE")).toBe(false);
    await user.click(button);
    await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
    expect(calls.filter((c) => c.method === "DELETE").map((c) => c.url)).toEqual([
      `/api/v1/servers/${makeServer().id}/databases/${DATABASE_ID}`,
    ]);
  });
});

describe("Databases tab: busy (409)", () => {
  const BUSY = "Another operation on this database is still in progress — try again in a moment.";
  const busy = fail(409, "CONFLICT", { reason: "busy" });

  it("a busy delete keeps the database and says why", async () => {
    const errorToast = vi.spyOn(toast, "error");
    routeFetch([
      ["GET", LIST, ok([makeServerDatabase()])],
      ["DELETE", /\/databases\/[^/]+$/, busy],
    ]);
    const user = userEvent.setup();
    wrap(<DatabasesTab server={makeServer()} me={makeMe()} />);
    await user.click(await screen.findByRole("button", { name: "Delete s55555555_luckperms" }));
    const confirm = await screen.findByRole("alertdialog");
    await user.type(within(confirm).getByLabelText(/to confirm/), "s55555555_luckperms");
    await user.click(within(confirm).getByRole("button", { name: "Delete database" }));
    await waitFor(() => expect(errorToast).toHaveBeenCalled());
    expect(errorToast).toHaveBeenCalledWith(
      "Could not delete the database",
      expect.objectContaining({ description: expect.stringContaining(BUSY) }),
    );
    // The row stays (the confirmation stays open for another try).
    expect(screen.getAllByText("s55555555_luckperms").some((el) => el.closest("tr"))).toBe(true);
    expect(screen.getByRole("alertdialog")).toBeTruthy();
  });

  it("a busy rotation says why and keeps a revealed password", async () => {
    const errorToast = vi.spyOn(toast, "error");
    routeFetch([
      ["GET", LIST, ok([makeServerDatabase()])],
      ["GET", /\/password$/, ok({ password: PASSWORD })],
      ["POST", /\/rotate-password$/, busy],
    ]);
    const user = userEvent.setup();
    wrap(<DatabasesTab server={makeServer()} me={makeMe()} />);
    await user.click(
      await screen.findByRole("button", { name: "Connection details for s55555555_luckperms" }),
    );
    const dialog = await screen.findByRole("dialog");
    await user.click(within(dialog).getByRole("button", { name: "Show password" }));
    await within(dialog).findByLabelText("Password");
    await user.click(within(dialog).getByRole("button", { name: "Rotate password" }));
    const confirm = await screen.findByRole("alertdialog");
    await user.click(within(confirm).getByRole("button", { name: "Rotate password" }));
    await waitFor(() => expect(errorToast).toHaveBeenCalled());
    expect(errorToast).toHaveBeenCalledWith(
      "Could not rotate the password",
      expect.objectContaining({ description: expect.stringContaining(BUSY) }),
    );
    // The rotation did not happen: the shown password is still the valid one.
    expect(within(dialog).getByLabelText("Password").textContent).toBe(PASSWORD);
  });
});

describe("Databases tab: status", () => {
  const ID2 = "aaaaaaaa-aaaa-4aaa-8aaa-00000000000";
  const row = (status: ServerDatabaseStatus, n: number) =>
    makeServerDatabase({ id: `${ID2}${n}`, database: `s55555555_${status}`, status });
  const STATUSES: ServerDatabaseStatus[] = [
    "ready",
    "creating",
    "rotating",
    "deleting",
    "password_unknown",
    "cleanup_pending",
  ];

  it("shows a badge for every status but ready, and gates delete by status", async () => {
    routeFetch([["GET", LIST, ok(STATUSES.map(row))]]);
    wrap(<DatabasesTab server={makeServer({ databaseLimit: 10 })} me={makeMe()} />);
    const tr = async (status: ServerDatabaseStatus) =>
      (await screen.findByText(`s55555555_${status}`)).closest("tr")!;
    const ready = await tr("ready");
    for (const label of Object.values(DATABASE_STATUS_META).map((m) => m.label))
      expect(within(ready).queryByText(label)).toBeNull();
    expect(within(await tr("creating")).getByText("Creating…")).toBeTruthy();
    expect(within(await tr("rotating")).getByText("Rotating password…")).toBeTruthy();
    expect(within(await tr("deleting")).getByText("Deleting…")).toBeTruthy();
    const unknown = within(await tr("password_unknown")).getByText("Password unknown — rotate again");
    expect(unknown.className).toContain("tone-warning");
    const cleanup = await tr("cleanup_pending");
    expect(within(cleanup).getByText("Cleanup pending").className).toContain("tone-warning");
    expect(within(cleanup).getByText(CLEANUP_PENDING_HINT)).toBeTruthy();

    const deleteDisabled = (status: ServerDatabaseStatus) =>
      (screen.getByRole("button", { name: `Delete s55555555_${status}` }) as HTMLButtonElement).disabled;
    expect(STATUSES.filter((s) => !deleteDisabled(s))).toEqual([
      "ready",
      "password_unknown",
      "cleanup_pending",
    ]);
  });

  async function openDetails(status: ServerDatabaseStatus) {
    const calls = routeFetch([
      ["GET", LIST, ok([makeServerDatabase({ status })])],
      ["GET", /\/password$/, ok({ password: PASSWORD })],
    ]);
    const user = userEvent.setup();
    wrap(<DatabasesTab server={makeServer()} me={makeMe()} />);
    await user.click(
      await screen.findByRole("button", { name: "Connection details for s55555555_luckperms" }),
    );
    return { calls, user, dialog: await screen.findByRole("dialog") };
  }
  const rotateButton = (dialog: HTMLElement) =>
    within(dialog).getByRole("button", { name: "Rotate password" }) as HTMLButtonElement;

  it("password_unknown: no reveal, a warning, and rotation stays available", async () => {
    const { calls, dialog } = await openDetails("password_unknown");
    expect(within(dialog).queryByRole("button", { name: "Show password" })).toBeNull();
    expect(within(dialog).getAllByText(/stored password may be wrong/).length).toBeGreaterThan(0);
    expect(within(dialog).getByText("Password unknown — rotate again")).toBeTruthy();
    expect(within(dialog).queryByLabelText("Connection string")).toBeNull();
    expect(rotateButton(dialog).disabled).toBe(false);
    expect(calls.some((c) => c.url.includes("/password"))).toBe(false);
  });

  it("cleanup_pending: no reveal and no rotation, with the reason", async () => {
    const { dialog } = await openDetails("cleanup_pending");
    expect(within(dialog).queryByRole("button", { name: "Show password" })).toBeNull();
    expect(within(dialog).getByText(/awaits cleanup after a failed operation/)).toBeTruthy();
    expect(within(dialog).getByText(CLEANUP_PENDING_HINT)).toBeTruthy();
    expect(rotateButton(dialog).disabled).toBe(true);
    expect(within(dialog).getByText(/delete it to retry the cleanup now/)).toBeTruthy();
  });

  it("creating: no reveal and no rotation", async () => {
    const { dialog } = await openDetails("creating");
    expect(within(dialog).queryByRole("button", { name: "Show password" })).toBeNull();
    expect(within(dialog).getByText(/still being created/)).toBeTruthy();
    expect(rotateButton(dialog).disabled).toBe(true);
  });

  it.each(["rotating", "deleting"] as const)(
    "%s: the current password can still be revealed, but not rotated",
    async (status) => {
      const { dialog, user } = await openDetails(status);
      await user.click(within(dialog).getByRole("button", { name: "Show password" }));
      expect((await within(dialog).findByLabelText("Password")).textContent).toBe(PASSWORD);
      expect(within(dialog).getByLabelText("Connection string")).toBeTruthy();
      expect(rotateButton(dialog).disabled).toBe(true);
    },
  );

  it("a password_unknown answer to the reveal says why and re-reads the list (the status changed)", async () => {
    const errorToast = vi.spyOn(toast, "error");
    let rows = [makeServerDatabase()];
    const calls = routeFetch([
      ["GET", LIST, () => jsonResponse(rows)],
      [
        "GET",
        /\/password$/,
        () => {
          rows = [makeServerDatabase({ status: "password_unknown" })];
          return jsonResponse(apiErrorBody("CONFLICT", "nope", "req-p", { reason: "password_unknown" }), {
            status: 409,
          });
        },
      ],
    ]);
    const user = userEvent.setup();
    wrap(<DatabasesTab server={makeServer()} me={makeMe()} />);
    await user.click(
      await screen.findByRole("button", { name: "Connection details for s55555555_luckperms" }),
    );
    const dialog = await screen.findByRole("dialog");
    const listReads = () => calls.filter((c) => c.method === "GET" && LIST.test(c.url)).length;
    const before = listReads();
    await user.click(within(dialog).getByRole("button", { name: "Show password" }));
    await waitFor(() => expect(errorToast).toHaveBeenCalled());
    expect(errorToast).toHaveBeenCalledWith(
      "Could not show the password",
      expect.objectContaining({
        description: expect.stringContaining(
          "The last password rotation could not be confirmed — rotate the password again.",
        ),
      }),
    );
    await waitFor(() => expect(listReads()).toBeGreaterThan(before));
    expect(
      await within(screen.getByRole("dialog")).findByText("Password unknown — rotate again"),
    ).toBeTruthy();
    expect(within(screen.getByRole("dialog")).queryByRole("button", { name: "Show password" })).toBeNull();
  });

  it("a create whose outcome is unknown says so and re-reads the list", async () => {
    let rows: unknown[] = [];
    const calls = routeFetch([
      ["GET", LIST, () => jsonResponse(rows)],
      [
        "POST",
        LIST,
        () => {
          rows = [makeServerDatabase({ status: "cleanup_pending" })];
          return jsonResponse(
            apiErrorBody("UPSTREAM_ERROR", "host", "req-u", {
              reason: "host_error",
              code: "ETIMEDOUT",
              unknownOutcome: true,
            }),
            { status: 502 },
          );
        },
      ],
    ]);
    const user = userEvent.setup();
    wrap(<DatabasesTab server={makeServer()} me={makeMe()} />);
    await screen.findByText("No databases yet");
    await user.click(screen.getByRole("button", { name: "Create database" }));
    const dialog = await screen.findByRole("dialog");
    await user.type(within(dialog).getByLabelText(/^Database name/), "luckperms");
    await user.click(within(dialog).getByRole("button", { name: "Create database" }));
    const alert = await within(dialog).findByRole("alert");
    expect(alert.textContent).toContain("(error ETIMEDOUT)");
    expect(alert.textContent).toContain(UNKNOWN_OUTCOME_MESSAGE);
    // The list behind the dialog now shows the entry awaiting cleanup.
    await waitFor(() => expect(calls.filter((c) => c.method === "GET" && LIST.test(c.url)).length).toBe(2));
    expect(await screen.findByText("Cleanup pending")).toBeTruthy();
  });

  it("a rejected rotation (not_ready) says why and re-reads the list", async () => {
    const errorToast = vi.spyOn(toast, "error");
    const calls = routeFetch([
      ["GET", LIST, ok([makeServerDatabase()])],
      ["POST", /\/rotate-password$/, fail(409, "CONFLICT", { reason: "not_ready" })],
    ]);
    const user = userEvent.setup();
    wrap(<DatabasesTab server={makeServer()} me={makeMe()} />);
    await user.click(
      await screen.findByRole("button", { name: "Connection details for s55555555_luckperms" }),
    );
    const dialog = await screen.findByRole("dialog");
    await user.click(rotateButton(dialog));
    const confirm = await screen.findByRole("alertdialog");
    await user.click(within(confirm).getByRole("button", { name: "Rotate password" }));
    await waitFor(() => expect(errorToast).toHaveBeenCalled());
    expect(errorToast).toHaveBeenCalledWith(
      "Could not rotate the password",
      expect.objectContaining({
        description: expect.stringContaining("This database is still being created or awaits cleanup."),
      }),
    );
    await waitFor(() => expect(calls.filter((c) => c.method === "GET" && LIST.test(c.url)).length).toBe(2));
  });
});

describe("remoteHint", () => {
  it("says what a normalised value is saved as", () => {
    expect(remoteHint("%")).not.toMatch(/Saved as/);
    expect(remoteHint("10.0.0.0/8")).toMatch(/^Saved as 10\.0\.0\.0\/255\.0\.0\.0\./);
    expect(remoteHint("%.Example.COM")).toMatch(/^Saved as %\.example\.com\./);
    expect(remoteHint("not valid!")).not.toMatch(/Saved as/);
  });
});
