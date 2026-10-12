import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { IDEMPOTENCY_HEADER, SERVER_OWNER_PERMISSIONS } from "@blockforge/contracts";
import type { Job } from "@blockforge/contracts";
import { JOB_ID, SERVER_ID, apiErrorBody, jsonResponse, makeMe, makeServer } from "@/test/fixtures";
import { makeClient } from "@/test/fake-socket";
import {
  EXT_ID,
  EXT_ID_2,
  HISTORY_ID,
  UPLOAD_ID,
  makeExtension,
  makeExtensionList,
  makeHistoryEntry,
  makeMetadata,
  makePlan,
  makePlannedFile,
  makeProject,
  makeSearchResult,
  makeUpdates,
} from "@/test/phase4b-fixtures";
import { RealtimeProvider } from "@/lib/realtime/provider";
import { ThemeProvider } from "@/lib/theme";
import { TooltipProvider } from "@/components/ui/tooltip";
import ExtensionsTab from "./extensions-tab";

// The transfer PUT is an XHR to the control plane; the upload flow around it is what is tested here.
const put = vi.hoisted(() =>
  vi.fn(async (_u: string, _b: Blob, onProgress: (n: number) => void) => onProgress(1)),
);
vi.mock("../files/upload", () => ({ putToTransferUrl: put }));

afterEach(() => {
  vi.unstubAllGlobals();
  put.mockClear();
});

type Call = { url: string; method: string; key: string | undefined; body: unknown };
type Reply = (call: Call) => Response | Promise<Response>;
function routeFetch(routes: Array<[string, RegExp, Reply | Reply[]]>) {
  const calls: Call[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init: RequestInit = {}) => {
      const headers = (init.headers ?? {}) as Record<string, string>;
      const call: Call = {
        url,
        method: init.method ?? "GET",
        key: headers[IDEMPOTENCY_HEADER],
        body: init.body ? JSON.parse(String(init.body)) : undefined,
      };
      calls.push(call);
      const r = routes.find(([m, p]) => m === call.method && p.test(url));
      if (!r) return jsonResponse(apiErrorBody("NOT_FOUND"), { status: 404 });
      const reply = Array.isArray(r[2]) ? (r[2].length > 1 ? r[2].shift()! : r[2][0]!) : r[2];
      return reply(call);
    }),
  );
  return calls;
}
const ok =
  (body: unknown, status = 200) =>
  () =>
    jsonResponse(body, { status });

const job: Job = {
  id: JOB_ID,
  type: "extensions.install",
  status: "running",
  targetType: "server",
  targetId: SERVER_ID,
  requestedBy: null,
  attempts: 1,
  error: null,
  result: null,
  createdAt: 1,
  startedAt: 1,
  finishedAt: null,
  steps: [
    {
      key: "fetch",
      label: "Download files",
      status: "running",
      message: null,
      startedAt: 1,
      finishedAt: null,
    },
  ],
};

const owner = makeServer({ software: "fabric", myPermissions: [...SERVER_OWNER_PERMISSIONS] });

function wrap(ui: ReactNode, client?: ReturnType<typeof makeClient>["client"]) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const content = <TooltipProvider>{ui}</TooltipProvider>;
  render(
    <ThemeProvider>
      <QueryClientProvider client={qc}>
        {client ? <RealtimeProvider client={client}>{content}</RealtimeProvider> : content}
      </QueryClientProvider>
    </ThemeProvider>,
  );
  return qc;
}

describe("Plugins & mods — installed", () => {
  it("lists jars by their metadata, with source, compatibility and scan state; upstream text stays text", async () => {
    routeFetch([
      [
        "GET",
        /\/extensions$/,
        ok(
          makeExtensionList({
            items: [
              makeExtension(),
              makeExtension({
                id: EXT_ID_2,
                path: "plugins/multi.jar",
                filename: "multi.jar",
                source: "upload",
                modrinth: null,
                metadata: [
                  makeMetadata({ id: "a", name: "<b>ModA</b>" }),
                  makeMetadata({ id: "b", name: "ModB" }),
                ],
                compatibility: {
                  loadable: false,
                  metadataIndex: 0,
                  problems: [
                    { code: "WRONG_PLATFORM", level: "error", message: "Built for Forge only" },
                    { code: "METADATA_WARNING", level: "warning", message: "<i>outdated schema</i>" },
                  ],
                },
              }),
            ],
            skipped: [{ name: "link.jar", reason: "symlink" }],
          }),
        ),
      ],
    ]);
    wrap(<ExtensionsTab server={owner} me={makeMe()} />);
    const row = (await screen.findByText("<b>ModA</b>, ModB")).closest("tr")!;
    expect(row.querySelector("b")).toBeNull();
    expect(within(row).getByText("Upload")).toBeTruthy();
    expect(within(row).getByText("Built for Forge only")).toBeTruthy();
    expect(within(row).getByText("<i>outdated schema</i>")).toBeTruthy();
    expect(within(row).getByText("2 mods in this jar")).toBeTruthy();
    const modrinth = screen.getByText("Modrinth").closest("a")!;
    expect(modrinth.getAttribute("href")).toBe("https://modrinth.com/project/essentialsx");
    expect(modrinth.getAttribute("rel")).toBe("noopener noreferrer");
    expect(modrinth.getAttribute("target")).toBe("_blank");
    const icon = document.querySelector("img")!;
    expect(icon.getAttribute("src")).toBe("https://cdn.modrinth.com/data/hXiIvTyT/icon.png");
    expect(icon.getAttribute("referrerpolicy")).toBe("no-referrer");
    expect(screen.getByText("1 file(s) not listed")).toBeTruthy();
    expect(screen.getByText(/scanned/)).toBeTruthy();
  });

  it("toggling and removing report the restart and whether the removal can be rolled back", async () => {
    const calls = routeFetch([
      ["GET", /\/extensions$/, ok(makeExtensionList())],
      [
        "PATCH",
        /\/extensions\//,
        ok({
          extension: makeExtension({ enabled: false, path: "plugins/EssentialsX-2.21.0.jar.disabled" }),
          restartRequired: true,
        }),
      ],
      [
        "DELETE",
        /\/extensions\//,
        ok({ restartRequired: true, historyEntryId: HISTORY_ID, rollbackAvailable: true }),
      ],
    ]);
    const user = userEvent.setup();
    wrap(<ExtensionsTab server={owner} me={makeMe()} />);
    await user.click(await screen.findByRole("switch", { name: "Disable EssentialsX" }));
    await waitFor(() => expect(calls.find((c) => c.method === "PATCH")?.body).toEqual({ enabled: false }));
    expect(await screen.findByText("Restart required")).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "Remove EssentialsX" }));
    await user.click(within(await screen.findByRole("alertdialog")).getByRole("button", { name: "Remove" }));
    expect(await screen.findByText(/It can be restored from History/)).toBeTruthy();
    expect(screen.queryByRole("switch", { name: /EssentialsX/ })).toBeNull();
  });

  it("Scan now starts an idempotent job and shows its progress; viewers get no controls", async () => {
    const calls = routeFetch([
      ["GET", /\/extensions$/, ok(makeExtensionList())],
      ["POST", /\/extensions\/scan$/, ok({ jobId: JOB_ID }, 202)],
      ["GET", /\/jobs\//, ok(job)],
    ]);
    const user = userEvent.setup();
    wrap(<ExtensionsTab server={owner} me={makeMe()} />);
    await user.click(await screen.findByRole("button", { name: "Scan now" }));
    await waitFor(() => expect(calls.some((c) => c.url.endsWith("/scan"))).toBe(true));
    const scan = calls.find((c) => c.url.endsWith("/scan"))!;
    expect(scan.body).toEqual({ full: false });
    expect(scan.key).toBeTruthy();
    expect(await screen.findByText("Scanning plugins & mods")).toBeTruthy();
  });

  it("view-only users see the list without controls", async () => {
    routeFetch([["GET", /\/extensions$/, ok(makeExtensionList())]]);
    wrap(
      <ExtensionsTab
        server={makeServer({ myPermissions: ["servers.view", "servers.extensions.view"] })}
        me={makeMe()}
      />,
    );
    await screen.findByText("EssentialsX");
    expect(screen.queryByRole("button", { name: "Scan now" })).toBeNull();
    expect(screen.queryByRole("button", { name: /Upload/ })).toBeNull();
    expect((screen.getByRole("switch", { name: "Disable EssentialsX" }) as HTMLButtonElement).disabled).toBe(
      true,
    );
  });

  it("live extensions.updated re-reads changed rows, drops removed ones and refetches on null", async () => {
    const calls = routeFetch([
      [
        "GET",
        /\/extensions$/,
        ok(
          makeExtensionList({
            items: [
              makeExtension(),
              makeExtension({
                id: EXT_ID_2,
                path: "plugins/b.jar",
                filename: "b.jar",
                metadata: [makeMetadata({ name: "Second" })],
              }),
            ],
          }),
        ),
      ],
      [
        "GET",
        new RegExp(`/extensions/${EXT_ID}$`),
        ok(makeExtension({ metadata: [makeMetadata({ name: "EssentialsX Renamed" })] })),
      ],
    ]);
    const { client, last } = makeClient();
    wrap(<ExtensionsTab server={owner} me={makeMe()} />, client);
    await screen.findByText("Second");
    act(() => last().open());
    const send = (changed: string[] | null) =>
      act(() =>
        last().receive({
          op: "event",
          topic: `server:${SERVER_ID}`,
          type: "extensions.updated",
          ts: 1,
          data: {
            serverId: SERVER_ID,
            scan: { status: "completed", scannedAt: 2, jobId: null, error: null },
            changed,
          },
        }),
      );
    send([EXT_ID, EXT_ID_2]);
    expect(await screen.findByText("EssentialsX Renamed")).toBeTruthy();
    await waitFor(() => expect(screen.queryByText("Second")).toBeNull()); // 404 → removed
    const before = calls.filter((c) => c.url.endsWith("/extensions")).length;
    send(null);
    await waitFor(() => expect(calls.filter((c) => c.url.endsWith("/extensions")).length).toBe(before + 1));
  });

  it("vanilla servers have no plugins or mods", async () => {
    routeFetch([
      ["GET", /\/extensions$/, ok(makeExtensionList({ installDir: null, kind: null, items: [] }))],
    ]);
    wrap(<ExtensionsTab server={owner} me={makeMe()} />);
    expect(await screen.findByText("This server software loads no plugins or mods")).toBeTruthy();
  });
});

describe("Plugins & mods — Modrinth", () => {
  it("search results are compatible-only with explained loader warnings; install sends the reviewed plan and re-confirms a changed one", async () => {
    const fresh = makePlan({
      files: [
        makePlannedFile(),
        makePlannedFile({
          reason: "dependency",
          requiredBy: ["gvQqBUqZ"],
          projectId: "DepDep01",
          projectSlug: "dep",
          projectTitle: "Dep",
          versionId: "Ver00009",
          filename: "dep-1.0.jar",
          url: "https://cdn.modrinth.com/data/DepDep01/versions/Ver00009/dep-1.0.jar",
          destPath: "mods/dep-1.0.jar",
        }),
      ],
    });
    const calls = routeFetch([
      ["GET", /\/extensions$/, ok(makeExtensionList({ installDir: "mods", kind: "mod", items: [] }))],
      ["GET", /\/modrinth\/search/, ok(makeSearchResult())],
      ["GET", /\/modrinth\/projects\//, ok(makeProject())],
      [
        "POST",
        /\/modrinth\/plan$/,
        ok(
          makePlan({
            warnings: [
              {
                code: "OPTIONAL_DEPENDENCY",
                level: "info",
                message: "Sodium is optional",
                projectId: null,
                versionId: null,
              },
            ],
            optionalDependencies: [
              {
                projectId: "AANobbMI",
                versionId: null,
                slug: "sodium",
                title: "Sodium",
                requiredBy: "gvQqBUqZ",
              },
            ],
          }),
        ),
      ],
      [
        "POST",
        /\/modrinth\/install$/,
        [
          () =>
            jsonResponse(
              apiErrorBody("CONFLICT", "plan changed", "req-1", { reason: "plan_changed", plan: fresh }),
              { status: 409 },
            ),
          ok({ jobId: JOB_ID }, 202),
        ],
      ],
      ["GET", /\/jobs\//, ok(job)],
    ]);
    const user = userEvent.setup();
    wrap(<ExtensionsTab server={owner} me={makeMe()} />);
    await user.click(await screen.findByRole("tab", { name: "Browse Modrinth" }));
    expect(await screen.findByText("<b>No-compromise</b> game logic optimization")).toBeTruthy();
    expect(screen.getByText("Loader warning")).toBeTruthy();
    expect(screen.getByText("Installed")).toBeTruthy();
    expect(screen.getByText(/1 result\(s\) on this page hidden/)).toBeTruthy();

    await user.click(screen.getByRole("button", { name: "View Lithium" }));
    const dialog = await screen.findByRole("dialog", {}, { timeout: 5000 });
    expect(await within(dialog).findByText(/<script>alert\(1\)<\/script>/)).toBeTruthy();
    expect(dialog.querySelector("script")).toBeNull();
    expect(await within(dialog).findByText("Sodium is optional")).toBeTruthy();
    // Opting in to an optional dependency re-plans with it.
    await user.click(within(dialog).getByRole("checkbox", { name: "Include Sodium" }));
    await waitFor(() =>
      expect(
        calls
          .filter((c) => c.url.endsWith("/plan"))
          .some((c) => (c.body as { includeOptional: string[] }).includeOptional.includes("AANobbMI")),
      ).toBe(true),
    );
    await waitFor(() =>
      expect((within(dialog).getByRole("button", { name: "Install" }) as HTMLButtonElement).disabled).toBe(
        false,
      ),
    );
    await user.click(within(dialog).getByRole("button", { name: "Install" }));
    expect(await within(dialog).findByText("The plan changed")).toBeTruthy();
    expect(within(dialog).getByText("Dep")).toBeTruthy();
    await user.click(within(dialog).getByRole("button", { name: "Confirm the new plan" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    const installs = calls.filter((c) => c.url.endsWith("/install"));
    expect(installs).toHaveLength(2);
    expect((installs[0]!.body as { expect: unknown[] }).expect).toEqual([
      { projectId: "gvQqBUqZ", versionId: "Ver00002", action: "install" },
    ]);
    expect((installs[1]!.body as { expect: unknown[] }).expect).toHaveLength(2);
    expect(installs[1]!.key).not.toBe(installs[0]!.key);
    expect(await screen.findByText("Installing Lithium")).toBeTruthy();
  });

  it("a plan with blocking errors cannot be installed", async () => {
    routeFetch([
      ["GET", /\/extensions$/, ok(makeExtensionList({ installDir: "mods", kind: "mod", items: [] }))],
      ["GET", /\/modrinth\/search/, ok(makeSearchResult())],
      ["GET", /\/modrinth\/projects\//, ok(makeProject())],
      [
        "POST",
        /\/modrinth\/plan$/,
        ok(
          makePlan({
            installable: false,
            warnings: [
              {
                code: "CLIENT_ONLY",
                level: "error",
                message: "Client-only mod",
                projectId: null,
                versionId: null,
              },
            ],
          }),
        ),
      ],
    ]);
    const user = userEvent.setup();
    wrap(<ExtensionsTab server={owner} me={makeMe()} />);
    await user.click(await screen.findByRole("tab", { name: "Browse Modrinth" }));
    await user.click(await screen.findByRole("button", { name: "View Lithium" }));
    const dialog = await screen.findByRole("dialog", {}, { timeout: 5000 });
    expect(await within(dialog).findByText("Client-only mod")).toBeTruthy();
    expect(within(dialog).getByText("Blocking problems")).toBeTruthy();
    expect((within(dialog).getByRole("button", { name: "Install" }) as HTMLButtonElement).disabled).toBe(
      true,
    );
  });
});

describe("Plugins & mods — updates, history, uploads", () => {
  it("checks for updates and applies the selected ones", async () => {
    const calls = routeFetch([
      ["GET", /\/extensions$/, ok(makeExtensionList())],
      [
        "GET",
        /\/extensions\/updates/,
        ok({
          ...makeUpdates(),
          items: [
            ...makeUpdates().items,
            {
              ...makeUpdates().items[0]!,
              extensionId: EXT_ID_2,
              path: "plugins/big.jar",
              file: null,
              problem: "TOO_LARGE",
            },
          ],
        }),
      ],
      ["POST", /\/updates\/apply$/, ok({ jobId: JOB_ID }, 202)],
      ["GET", /\/jobs\//, ok(job)],
    ]);
    const user = userEvent.setup();
    wrap(<ExtensionsTab server={owner} me={makeMe()} />);
    await user.click(await screen.findByRole("tab", { name: "Updates" }));
    await user.click(screen.getByRole("button", { name: "Check for updates" }));
    expect((await screen.findAllByText("2.21.0 → 2.22.0")).length).toBe(2);
    // Problems use the contract's descriptions; such updates can't be selected.
    expect(
      screen.getByText(/Can't be applied: The new version's file is larger than BlockForge installs/),
    ).toBeTruthy();
    expect(
      (screen.getByRole("checkbox", { name: "Update plugins/big.jar" }) as HTMLButtonElement).disabled,
    ).toBe(true);
    await user.click(screen.getByRole("checkbox", { name: "Update EssentialsX" }));
    await user.click(screen.getByRole("button", { name: /Apply 1 update/ }));
    await waitFor(() => expect(calls.some((c) => c.url.endsWith("/apply"))).toBe(true));
    const apply = calls.find((c) => c.url.endsWith("/apply"))!;
    expect(apply.body).toEqual({ extensionIds: [EXT_ID], allowPrerelease: false });
    expect(apply.key).toBeTruthy();
  });

  it("history rolls back after confirmation and explains unavailable rollbacks", async () => {
    const calls = routeFetch([
      ["GET", /\/extensions$/, ok(makeExtensionList())],
      [
        "GET",
        /\/extensions\/history/,
        ok({
          items: [
            makeHistoryEntry(),
            makeHistoryEntry({
              id: "f0000000-0000-4000-8000-000000000002",
              action: "install",
              extensionName: "Older",
              from: null,
              rollback: { available: false, reason: "superseded" },
            }),
          ],
          nextCursor: null,
        }),
      ],
      ["POST", /\/rollback$/, ok({ jobId: JOB_ID }, 202)],
      ["GET", /\/jobs\//, ok(job)],
    ]);
    const user = userEvent.setup();
    wrap(<ExtensionsTab server={owner} me={makeMe()} />);
    await user.click(await screen.findByRole("tab", { name: "History" }));
    expect(await screen.findByText("2.21.0 → 2.22.0")).toBeTruthy();
    expect(
      (screen.getByRole("button", { name: "Roll back: Installed Older" }) as HTMLButtonElement).disabled,
    ).toBe(true);
    await user.click(screen.getByRole("button", { name: "Roll back: Updated EssentialsX" }));
    expect(calls.some((c) => c.url.endsWith("/rollback"))).toBe(false);
    await user.click(
      within(await screen.findByRole("alertdialog")).getByRole("button", { name: "Roll back" }),
    );
    await waitFor(() =>
      expect(calls.some((c) => c.url.endsWith(`/history/${HISTORY_ID}/rollback`))).toBe(true),
    );
  });

  it("uploads stage the jar, show the refusal reason and retry completion with other options", async () => {
    const calls = routeFetch([
      ["GET", /\/extensions$/, ok(makeExtensionList())],
      [
        "POST",
        /\/extensions\/uploads$/,
        ok({ url: "/api/v1/transfers/tok", expiresAt: 9, uploadId: UPLOAD_ID }),
      ],
      [
        "POST",
        /\/complete$/,
        [
          () =>
            jsonResponse(
              apiErrorBody("CONFLICT", "exists", "req-2", {
                reason: "exists",
                compatibility: null,
                existing: { extensionId: EXT_ID, path: "plugins/Essentials.jar" },
              }),
              { status: 409 },
            ),
          ok({
            extension: makeExtension({ source: "upload", modrinth: null }),
            compatibility: { loadable: true, metadataIndex: 0, problems: [] },
            warnings: [
              { code: "REPLACED_EXISTING", level: "info", message: "Replaced plugins/Essentials.jar" },
            ],
            restartRequired: true,
          }),
        ],
      ],
    ]);
    const user = userEvent.setup();
    wrap(<ExtensionsTab server={owner} me={makeMe()} />);
    await user.click(await screen.findByRole("button", { name: "Upload .jar" }));
    const dialog = await screen.findByRole("dialog", {}, { timeout: 5000 });
    await user.upload(within(dialog).getByLabelText("Jar file"), new File(["PK"], "Essentials.jar"));
    await user.click(within(dialog).getByRole("button", { name: "Upload" }));
    expect(await within(dialog).findByText(/A file with this name already exists/)).toBeTruthy();
    expect(put).toHaveBeenCalledWith(
      "/api/v1/transfers/tok",
      expect.any(File),
      expect.any(Function),
      expect.anything(),
    );
    await user.click(within(dialog).getByRole("switch", { name: "Replace the existing file" }));
    await user.click(within(dialog).getByRole("button", { name: "Try again with these options" }));
    expect(await within(dialog).findByText("Installed")).toBeTruthy();
    expect(within(dialog).getByText("Replaced plugins/Essentials.jar")).toBeTruthy();
    const completes = calls.filter((c) => c.url.endsWith("/complete"));
    expect(completes.map((c) => c.body)).toEqual([
      { replaceExisting: false, allowIncompatible: false },
      { replaceExisting: true, allowIncompatible: false },
    ]);
    expect(calls.filter((c) => c.url.endsWith("/uploads"))).toHaveLength(1);
  });

  it("hides uploads when the list reports the policy off", async () => {
    routeFetch([
      ["GET", /\/extensions$/, ok(makeExtensionList({ uploads: { allowed: false, requireMetadata: true } }))],
    ]);
    wrap(<ExtensionsTab server={owner} me={makeMe()} />);
    expect(await screen.findByText("EssentialsX")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Upload .jar" })).toBeNull();
  });

  it("hides uploads once the policy refuses them", async () => {
    routeFetch([
      ["GET", /\/extensions$/, ok(makeExtensionList())],
      [
        "POST",
        /\/extensions\/uploads$/,
        () =>
          jsonResponse(
            apiErrorBody("PRECONDITION_FAILED", "off", "req-3", {
              reason: "uploads_disabled",
              compatibility: null,
              existing: null,
            }),
            { status: 422 },
          ),
      ],
    ]);
    const user = userEvent.setup();
    wrap(<ExtensionsTab server={owner} me={makeMe()} />);
    await user.click(await screen.findByRole("button", { name: "Upload .jar" }));
    const dialog = await screen.findByRole("dialog", {}, { timeout: 5000 });
    await user.upload(within(dialog).getByLabelText("Jar file"), new File(["PK"], "Essentials.jar"));
    await user.click(within(dialog).getByRole("button", { name: "Upload" }));
    expect(await screen.findByText(/turned off by an administrator/)).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Upload .jar" })).toBeNull();
  });
});
