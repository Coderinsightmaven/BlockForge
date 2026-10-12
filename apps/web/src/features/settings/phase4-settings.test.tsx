import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ApiKey } from "@blockforge/contracts";
import { apiErrorBody, jsonResponse, makeMe } from "@/test/fixtures";
import { createQueryClient } from "@/lib/queries";
import { ThemeProvider } from "@/lib/theme";
import { TooltipProvider } from "@/components/ui/tooltip";
import ApiKeysCard from "./api-keys";
import BackupStorageCard from "./backup-storage";
import { SettingsPage } from "./settings-page";

afterEach(() => vi.unstubAllGlobals());

type Call = { url: string; method: string; body: unknown };
function routeFetch(routes: Array<[string, RegExp, (c: Call) => Response]>) {
  const calls: Call[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init: RequestInit = {}) => {
      const call = {
        url,
        method: init.method ?? "GET",
        body: init.body ? JSON.parse(String(init.body)) : undefined,
      };
      calls.push(call);
      const r = routes.find(([m, p]) => m === call.method && p.test(url));
      return r ? r[2](call) : jsonResponse(apiErrorBody("NOT_FOUND"), { status: 404 });
    }),
  );
  return calls;
}

function wrap(ui: ReactNode) {
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

const key = (over: Partial<ApiKey> = {}): ApiKey => ({
  id: "d0000000-0000-4000-8000-000000000001",
  name: "CI deploys",
  prefix: "bfk_0123456789abcdef",
  permissions: null,
  allowedIps: [],
  expiresAt: null,
  lastUsedAt: null,
  lastUsedIp: null,
  createdAt: 1_760_000_000_000,
  ...over,
});
const SECRET = `bfk_0123456789abcdef_${"S".repeat(43)}`;

describe("API keys", () => {
  it("lists keys with scope, IPs, expiry and last use", async () => {
    routeFetch([
      [
        "GET",
        /\/account\/api-keys$/,
        () =>
          jsonResponse([
            key(),
            key({
              id: "d0000000-0000-4000-8000-000000000002",
              name: "Old",
              permissions: ["servers.control", "servers.view"],
              allowedIps: ["10.0.0.0/8"],
              expiresAt: 1_000,
              lastUsedAt: 1_759_000_000_000,
              lastUsedIp: "203.0.113.9",
            }),
          ]),
      ],
    ]);
    wrap(<ApiKeysCard me={makeMe()} />);
    const row = (await screen.findByText("CI deploys")).closest("tr")!;
    expect(within(row).getByText("All my permissions")).toBeTruthy();
    expect(within(row).getByText("Any address")).toBeTruthy();
    expect(within(row).getAllByText("Never")).toHaveLength(2);
    const old = screen.getByText("Old").closest("tr")!;
    expect(within(old).getByText(/2 permissions/)).toBeTruthy();
    expect(within(old).getByText("10.0.0.0/8")).toBeTruthy();
    expect(within(old).getByText("Expired")).toBeTruthy();
    expect(within(old).getByText("203.0.113.9")).toBeTruthy();
  });

  it("creates a limited key and shows the secret exactly once, outside every cache", async () => {
    const calls = routeFetch([
      ["GET", /\/account\/api-keys$/, () => jsonResponse([])],
      [
        "GET",
        /\/account\/permissions$/,
        () =>
          jsonResponse({
            global: ["monitoring.view", "settings.manage"],
            scoped: [],
            servers: [
              {
                serverId: "55555555-5555-4555-8555-555555555555",
                serverName: "Survival",
                via: "owner",
                permissions: ["servers.view", "servers.control"],
              },
            ],
          }),
      ],
      [
        "POST",
        /\/account\/api-keys$/,
        () =>
          jsonResponse(
            {
              key: key({ name: "Bot", permissions: ["servers.control"], allowedIps: ["203.0.113.7"] }),
              secret: SECRET,
            },
            { status: 201 },
          ),
      ],
    ]);
    const user = userEvent.setup();
    const qc = wrap(<ApiKeysCard me={makeMe()} />);
    await user.click(await screen.findByRole("button", { name: "Create key" }));
    const dialog = await screen.findByRole("dialog");
    await user.type(within(dialog).getByLabelText(/^Name/), "Bot");
    await user.click(within(dialog).getByRole("radio", { name: "Only selected permissions" }));
    // Forbidden permissions are never offered.
    expect(within(dialog).queryByRole("checkbox", { name: "settings.manage" })).toBeNull();
    await user.click(within(dialog).getByRole("button", { name: "Create key" }));
    expect(within(dialog).getByText(/Choose at least one permission/)).toBeTruthy();
    // servers.view and servers.control come from owning "Survival".
    expect(within(dialog).getAllByText("on 1 server")).toHaveLength(2);
    await user.click(within(dialog).getByRole("checkbox", { name: "servers.control" }));
    await user.type(within(dialog).getByLabelText("Allowed IP addresses"), "not-an-ip");
    await user.click(within(dialog).getByRole("button", { name: "Create key" }));
    expect(within(dialog).getByText(/Not an IP address or CIDR range: not-an-ip/)).toBeTruthy();
    await user.clear(within(dialog).getByLabelText("Allowed IP addresses"));
    await user.type(within(dialog).getByLabelText("Allowed IP addresses"), "203.0.113.7");
    await user.click(within(dialog).getByRole("button", { name: "Create key" }));

    const secretDialog = await screen.findByRole("dialog", { name: "Copy your API key now" });
    expect(within(secretDialog).getByLabelText("API key").textContent).toBe(SECRET);
    expect(
      within(secretDialog).getByText(
        `curl -H "Authorization: Bearer ${SECRET}" ${window.location.origin}/api/v1/servers`,
      ),
    ).toBeTruthy();
    expect(calls.find((c) => c.method === "POST")!.body).toEqual({
      name: "Bot",
      permissions: ["servers.control"],
      allowedIps: ["203.0.113.7"],
      expiresInDays: 90,
    });
    // Neither the query cache nor the mutation cache keeps the secret.
    await waitFor(() => {
      const caches = JSON.stringify([
        qc
          .getQueryCache()
          .getAll()
          .map((q) => q.state.data),
        qc
          .getMutationCache()
          .getAll()
          .map((m) => [m.state.data, m.state.variables]),
      ]);
      expect(caches).not.toContain(SECRET);
    });
    await user.click(within(secretDialog).getByRole("button", { name: "I've stored it" }));
    await waitFor(() => expect(document.body.textContent).not.toContain(SECRET));
  });

  it("offers only role permissions until GET /account/permissions exists (404)", async () => {
    routeFetch([["GET", /\/account\/api-keys$/, () => jsonResponse([])]]);
    const user = userEvent.setup();
    wrap(<ApiKeysCard me={makeMe({ permissions: ["nodes.view", "users.manage"] })} />);
    await user.click(await screen.findByRole("button", { name: "Create key" }));
    const dialog = await screen.findByRole("dialog");
    await user.click(within(dialog).getByRole("radio", { name: "Only selected permissions" }));
    expect(
      await within(dialog).findByText(/Server permissions from ownership\/subuser grants: coming soon/),
    ).toBeTruthy();
    expect(within(dialog).getByRole("checkbox", { name: "nodes.view" })).toBeTruthy();
    expect(within(dialog).queryByRole("checkbox", { name: "users.manage" })).toBeNull();
    expect(within(dialog).queryByRole("checkbox", { name: "servers.control" })).toBeNull();
  });

  it("revokes only after confirmation", async () => {
    const calls = routeFetch([
      ["GET", /\/account\/api-keys$/, () => jsonResponse([key()])],
      ["DELETE", /\/account\/api-keys\//, () => new Response(null, { status: 204 })],
    ]);
    const user = userEvent.setup();
    wrap(<ApiKeysCard me={makeMe()} />);
    await user.click(await screen.findByRole("button", { name: "Revoke CI deploys" }));
    const confirm = await screen.findByRole("alertdialog");
    expect(calls.some((c) => c.method === "DELETE")).toBe(false);
    await user.click(within(confirm).getByRole("button", { name: "Revoke key" }));
    await waitFor(() => expect(calls.some((c) => c.method === "DELETE")).toBe(true));
  });
});

describe("Backup storage settings", () => {
  const s3 = {
    type: "s3",
    endpoint: "https://s3.example.test",
    region: "eu-central-1",
    bucket: "bf-backups",
    prefix: "blockforge/",
    forcePathStyle: false,
    accessKeyId: "AKIA123",
  };
  /** `GET/PUT /settings/backups.storage` respond with the generic settings wrapper. */
  const view = (value: object, secretAccessKeySet: boolean) => ({
    key: "backups.storage",
    value,
    secretAccessKeySet,
  });

  it("keeps a stored secret, tests typed values before saving and forgets a rotated secret", async () => {
    const ROTATED = "rotated-S3-secret-value";
    const calls = routeFetch([
      // The real wire shape: secret-free value + flag beside it.
      ["GET", /\/settings\/backups\.storage$/, () => jsonResponse(view(s3, true))],
      [
        "PUT",
        /\/settings\/backups\.storage$/,
        () => jsonResponse(view({ ...s3, region: "eu-west-1" }, true)),
      ],
      [
        "POST",
        /\/settings\/backups\.storage\/test$/,
        () => jsonResponse({ ok: false, error: "<b>AccessDenied</b>: probe refused" }),
      ],
    ]);
    const user = userEvent.setup();
    const qc = wrap(<BackupStorageCard />);
    expect(((await screen.findByLabelText(/^Bucket/)) as HTMLInputElement).value).toBe("bf-backups");
    const secret = () => screen.getByLabelText(/^Secret access key/) as HTMLInputElement;
    expect(secret().value).toBe("");
    expect(screen.getByText(/A secret is stored\. Leave blank to keep it/)).toBeTruthy();

    // Unsaved values are tested as typed; a blank secret means "use the stored one".
    await user.clear(screen.getByLabelText(/^Region/));
    await user.type(screen.getByLabelText(/^Region/), "eu-west-1");
    await user.click(screen.getByRole("button", { name: "Test connection" }));
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("<b>AccessDenied</b>: probe refused");
    expect(alert.querySelector("b")).toBeNull();
    expect(calls.find((c) => c.url.endsWith("/test"))!.body).toEqual({
      value: { ...s3, region: "eu-west-1" },
    });

    await user.type(secret(), ROTATED);
    await user.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(calls.some((c) => c.method === "PUT")).toBe(true));
    expect(calls.find((c) => c.method === "PUT")!.body).toEqual({
      value: { ...s3, region: "eu-west-1", secretAccessKey: ROTATED },
    });
    // The typed secret is gone from the form, the DOM and every cache once saved.
    await waitFor(() => expect(secret().value).toBe(""));
    expect(document.body.innerHTML).not.toContain(ROTATED);
    await waitFor(() => {
      const caches = JSON.stringify([
        qc
          .getQueryCache()
          .getAll()
          .map((q) => q.state.data),
        qc
          .getMutationCache()
          .getAll()
          .map((m) => [m.state.data, m.state.variables]),
      ]);
      expect(caches).not.toContain(ROTATED);
    });
  });

  it("requires a typed secret when S3 is configured but none is stored", async () => {
    const calls = routeFetch([
      ["GET", /\/settings\/backups\.storage$/, () => jsonResponse(view(s3, false))],
      ["POST", /\/settings\/backups\.storage\/test$/, () => jsonResponse({ ok: true, error: null })],
    ]);
    const user = userEvent.setup();
    wrap(<BackupStorageCard />);
    await screen.findByLabelText(/^Bucket/);
    expect(screen.queryByText(/Leave blank/)).toBeNull();
    const test = screen.getByRole("button", { name: "Test connection" }) as HTMLButtonElement;
    expect(test.disabled).toBe(true);
    await user.type(screen.getByLabelText(/^Region/), "x");
    await user.click(screen.getByRole("button", { name: "Save" }));
    expect(screen.getByText("Enter the secret access key.")).toBeTruthy();
    expect(calls.some((c) => c.method === "PUT")).toBe(false);
    await user.type(screen.getByLabelText(/^Secret access key/), "typed");
    expect(test.disabled).toBe(false);
    await user.click(test);
    expect(await screen.findByText("Connection works")).toBeTruthy();
    expect(
      (calls.find((c) => c.url.endsWith("/test"))!.body as { value: { secretAccessKey: string } }).value
        .secretAccessKey,
    ).toBe("typed");
  });

  it("requires the secret when switching from local to S3", async () => {
    const calls = routeFetch([
      ["GET", /\/settings\/backups\.storage$/, () => jsonResponse(view({ type: "local" }, false))],
    ]);
    const user = userEvent.setup();
    wrap(<BackupStorageCard />);
    await user.click(await screen.findByRole("radio", { name: /S3-compatible/ }));
    await user.type(screen.getByLabelText(/^Endpoint/), "https://minio.example.test");
    await user.type(screen.getByLabelText(/^Region/), "us-east-1");
    await user.type(screen.getByLabelText(/^Bucket/), "backups");
    await user.type(screen.getByLabelText(/^Access key ID/), "minio");
    await user.click(screen.getByRole("button", { name: "Save" }));
    expect(screen.getByText("Enter the secret access key.")).toBeTruthy();
    expect(calls.some((c) => c.method === "PUT")).toBe(false);
    expect((screen.getByRole("button", { name: "Test connection" }) as HTMLButtonElement).disabled).toBe(
      true,
    );
    // Switching back to local discards a typed secret.
    await user.type(screen.getByLabelText(/^Secret access key/), "abc");
    await user.click(screen.getByRole("radio", { name: /On the node/ }));
    await user.click(screen.getByRole("radio", { name: /S3-compatible/ }));
    expect((screen.getByLabelText(/^Secret access key/) as HTMLInputElement).value).toBe("");
  });

  it("refuses a response that would carry the secret", async () => {
    routeFetch([
      [
        "GET",
        /\/settings\/backups\.storage$/,
        () => jsonResponse(view({ ...s3, secretAccessKey: "LEAKED" }, true)),
      ],
    ]);
    const qc = wrap(<BackupStorageCard />);
    expect(await screen.findByText("Could not load backup storage")).toBeTruthy();
    expect(document.body.innerHTML).not.toContain("LEAKED");
    expect(
      JSON.stringify(
        qc
          .getQueryCache()
          .getAll()
          .map((q) => q.state.data),
      ),
    ).not.toContain("LEAKED");
  });
});

describe("Settings tabs", () => {
  it("offers API keys to everyone and backup storage only with settings.manage", () => {
    const { unmount } = render(
      <ThemeProvider>
        <QueryClientProvider client={new QueryClient()}>
          <SettingsPage me={makeMe()} tab="account" onTabChange={() => {}} />
        </QueryClientProvider>
      </ThemeProvider>,
    );
    expect(screen.getByRole("tab", { name: "API keys" })).toBeTruthy();
    expect(screen.queryByRole("tab", { name: "Backup storage" })).toBeNull();
    unmount();
    render(
      <ThemeProvider>
        <QueryClientProvider client={new QueryClient()}>
          <SettingsPage
            me={makeMe({ permissions: ["settings.manage"] })}
            tab="account"
            onTabChange={() => {}}
          />
        </QueryClientProvider>
      </ThemeProvider>,
    );
    expect(screen.getByRole("tab", { name: "Backup storage" })).toBeTruthy();
  });
});
