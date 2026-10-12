import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { RouterProvider, createMemoryHistory, createRootRoute, createRouter } from "@tanstack/react-router";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { IDEMPOTENCY_HEADER, SERVER_OWNER_PERMISSIONS } from "@blockforge/contracts";
import type { Job, Permission } from "@blockforge/contracts";
import {
  JOB_ID,
  SERVER_ID,
  apiErrorBody,
  jsonResponse,
  makeBackup,
  makeMe,
  makeSchedule,
  makeServer,
} from "@/test/fixtures";
import { formatInZone } from "@/lib/cron";
import { ThemeProvider } from "@/lib/theme";
import { TooltipProvider } from "@/components/ui/tooltip";
import { SidebarNav } from "@/components/shell/sidebar";
import BackupsTab from "./tabs/backups-tab";
import SchedulesTab from "./tabs/schedules-tab";
import { ServerLiveStats } from "./server-common";

afterEach(() => vi.unstubAllGlobals());

type Call = { url: string; method: string; key: string | undefined; body: unknown };
type Reply = (call: Call) => Response | Promise<Response>;

/** Fetch stub routed by method + path; unknown routes answer 404. */
function routeFetch(routes: Array<[method: string, path: RegExp, reply: Reply | Reply[]]>) {
  const calls: Call[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init: RequestInit = {}) => {
      const method = init.method ?? "GET";
      const headers = (init.headers ?? {}) as Record<string, string>;
      const call: Call = {
        url,
        method,
        key: headers[IDEMPOTENCY_HEADER],
        body: init.body ? JSON.parse(String(init.body)) : undefined,
      };
      calls.push(call);
      const route = routes.find(([m, p]) => m === method && p.test(url));
      if (!route) return jsonResponse(apiErrorBody("NOT_FOUND"), { status: 404 });
      const reply = Array.isArray(route[2])
        ? route[2].length > 1
          ? route[2].shift()!
          : route[2][0]!
        : route[2];
      return reply(call);
    }),
  );
  return calls;
}
const ok =
  (body: unknown, status = 200) =>
  () =>
    jsonResponse(body, { status });
const offline = () => Promise.reject(new TypeError("Failed to fetch"));

function wrap(ui: ReactNode) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <ThemeProvider>
      <QueryClientProvider client={qc}>
        <TooltipProvider>{ui}</TooltipProvider>
      </QueryClientProvider>
    </ThemeProvider>,
  );
  return qc;
}

const ID = (n: number) => `b0000000-0000-4000-8000-00000000000${n}`;
const owner = [...SERVER_OWNER_PERMISSIONS] as Permission[];

// -------------------------------------------------------------------------------------------------

describe("Backups tab", () => {
  const job: Job = {
    id: JOB_ID,
    type: "server.backup",
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
      { key: "save", label: "Save world", status: "succeeded", message: null, startedAt: 1, finishedAt: 2 },
      {
        key: "archive",
        label: "Write archive",
        status: "running",
        message: null,
        startedAt: 2,
        finishedAt: null,
      },
    ],
  };

  it("lists status, size, storage, consistency, lock and author; failed errors stay text", async () => {
    routeFetch([
      [
        "GET",
        /\/backups$/,
        ok([
          makeBackup({ id: ID(1), locked: true }),
          makeBackup({
            id: ID(2),
            name: "broken",
            status: "failed",
            error: '<img src=x onerror="alert(1)"> disk full',
            consistency: null,
            sizeBytes: null,
            storage: "s3",
          }),
          makeBackup({ id: ID(3), name: "now", status: "running", jobId: JOB_ID, consistency: null }),
        ]),
      ],
      ["GET", /\/jobs\//, ok(job)],
    ]);
    wrap(<BackupsTab server={makeServer({ backupLimit: 3 })} me={makeMe()} />);
    const row = (await screen.findByText("Before 1.21 update")).closest("tr")!;
    expect(within(row).getByText("Completed")).toBeTruthy();
    expect(within(row).getByText("Locked")).toBeTruthy();
    expect(within(row).getByText(/by You/)).toBeTruthy();
    expect(within(row).getByText("Saved & flushed")).toBeTruthy();
    expect(within(row).getByText("Local")).toBeTruthy();
    expect(within(row).getByText("512 MiB")).toBeTruthy();
    expect(
      (within(row).getByRole("button", { name: "Delete Before 1.21 update" }) as HTMLButtonElement).disabled,
    ).toBe(true);
    const failed = screen.getByText("broken").closest("tr")!;
    expect(within(failed).getByText('<img src=x onerror="alert(1)"> disk full')).toBeTruthy();
    expect(failed.querySelector("img")).toBeNull();
    expect(within(failed).getByText("S3")).toBeTruthy();
    expect(
      (within(failed).getByRole("button", { name: "Download broken" }) as HTMLButtonElement).disabled,
    ).toBe(true);
    // Failed backups hold no slot.
    expect(screen.getByText("2 / 3 used")).toBeTruthy();
    // Live job progress for the running backup.
    expect(await screen.findByRole("progressbar", { name: "Progress of now" })).toBeTruthy();
    expect(screen.getByText(/1\/2 · Write archive/)).toBeTruthy();
  });

  it("blocks creating at the limit until rotation is on, and retries with the same key", async () => {
    const created = makeBackup({ id: ID(9), name: "fresh", status: "pending", jobId: JOB_ID });
    const calls = routeFetch([
      ["GET", /\/backups$/, ok([makeBackup({ id: ID(1) }), makeBackup({ id: ID(2), name: "second" })])],
      ["POST", /\/backups$/, [offline, ok({ backup: created, jobId: JOB_ID }, 202)]],
      ["GET", /\/jobs\//, ok(job)],
    ]);
    const user = userEvent.setup();
    wrap(<BackupsTab server={makeServer({ backupLimit: 2, state: "stopped" })} me={makeMe()} />);
    await user.click(await screen.findByRole("button", { name: "Create backup" }));
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByText("2 / 2 backups used on this server.")).toBeTruthy();
    expect(within(dialog).getByText("Backup limit reached")).toBeTruthy();
    const submit = within(dialog).getByRole("button", { name: "Create backup" }) as HTMLButtonElement;
    expect(submit.disabled).toBe(true);
    await user.click(within(dialog).getByRole("switch", { name: "Rotate at the limit" }));
    expect(submit.disabled).toBe(false);
    await user.type(within(dialog).getByLabelText("Ignore"), "*.log{Enter}logs/");
    await user.click(submit);
    await waitFor(() => expect(calls.filter((c) => c.method === "POST")).toHaveLength(1));
    expect(await within(dialog).findByText(/outcome is unknown/)).toBeTruthy();
    expect((within(dialog).getByRole("switch", { name: "Lock" }) as HTMLButtonElement).disabled).toBe(true);
    await user.click(submit);
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    const posts = calls.filter((c) => c.method === "POST");
    expect(posts).toHaveLength(2);
    expect(posts[1]!.key).toBeTruthy();
    expect(posts[1]!.key).toBe(posts[0]!.key);
    expect(posts[1]!.body).toEqual({
      ignore: ["*.log", "logs/"],
      locked: false,
      stopServer: false,
      rotate: true,
    });
    // The new backup appears from the response.
    expect(await screen.findByText("fresh")).toBeTruthy();
  });

  it("restoring over everything needs the server name typed; the safety backup is on by default", async () => {
    const calls = routeFetch([
      ["GET", /\/backups$/, ok([makeBackup({ id: ID(1) })])],
      ["POST", /\/restore$/, ok({ jobId: JOB_ID }, 202)],
    ]);
    const user = userEvent.setup();
    // Restore may start while running: the job stops the server first.
    wrap(<BackupsTab server={makeServer({ state: "running" })} me={makeMe()} />);
    await user.click(await screen.findByRole("button", { name: "Restore Before 1.21 update" }));
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByText(/it will be stopped before the files are restored/)).toBeTruthy();
    expect(
      within(dialog).getByRole("switch", { name: "Take a safety backup first" }).getAttribute("aria-checked"),
    ).toBe("true");
    await user.click(within(dialog).getByRole("switch", { name: "Delete all current files first" }));
    const restore = within(dialog).getByRole("button", { name: "Restore" }) as HTMLButtonElement;
    expect(restore.disabled).toBe(true);
    await user.type(within(dialog).getByLabelText(/Type Survival to confirm/), "Survival");
    expect(restore.disabled).toBe(false);
    await user.click(restore);
    await waitFor(() => expect(calls.some((c) => c.method === "POST")).toBe(true));
    expect(calls.find((c) => c.method === "POST")!.body).toEqual({
      truncate: true,
      safetyBackup: true,
      startAfter: true,
    });
  });

  it("restore retries replay the same key with frozen options; a rejection lets options change", async () => {
    const calls = routeFetch([
      ["GET", /\/backups$/, ok([makeBackup({ id: ID(1) })])],
      [
        "POST",
        /\/restore$/,
        [
          offline,
          () =>
            jsonResponse(apiErrorBody("CONFLICT", "still running", "req-2", { reason: "in_progress" }), {
              status: 409,
            }),
          () => jsonResponse(apiErrorBody("CONFLICT", "server busy", "req-3"), { status: 409 }),
          ok({ jobId: JOB_ID }, 202),
        ],
      ],
    ]);
    const user = userEvent.setup();
    wrap(<BackupsTab server={makeServer({ state: "stopped" })} me={makeMe()} />);
    await user.click(await screen.findByRole("button", { name: "Restore Before 1.21 update" }));
    const dialog = await screen.findByRole("dialog");
    const restore = within(dialog).getByRole("button", { name: "Restore" });
    const startAfter = within(dialog).getByRole("switch", {
      name: "Start the server afterwards",
    }) as HTMLButtonElement;
    await user.click(startAfter); // off
    await user.click(restore); // network failure: outcome unknown
    expect(await within(dialog).findByText(/outcome is unknown/)).toBeTruthy();
    expect(startAfter.disabled).toBe(true);
    await user.click(restore); // 409 in_progress: still unknown, same key
    await waitFor(() => expect(calls.filter((c) => c.method === "POST")).toHaveLength(2));
    expect(startAfter.disabled).toBe(true);
    await user.click(restore); // 409 without reason: definitive rejection
    await waitFor(() => expect(calls.filter((c) => c.method === "POST")).toHaveLength(3));
    await waitFor(() => expect(startAfter.disabled).toBe(false));
    const posts = () => calls.filter((c) => c.method === "POST");
    expect(posts()[1]!.key).toBe(posts()[0]!.key);
    expect(posts()[2]!.key).toBe(posts()[0]!.key);
    expect(posts()[0]!.body).toEqual({ truncate: false, safetyBackup: true, startAfter: false });
    await user.click(startAfter); // back on: a different request, a new key
    await user.click(restore);
    await waitFor(() => expect(posts()).toHaveLength(4));
    expect(posts()[3]!.key).not.toBe(posts()[0]!.key);
    expect(posts()[3]!.body).toEqual({ truncate: false, safetyBackup: true, startAfter: true });
  });

  it("a deleted backup leaves the list at once and the count drops", async () => {
    const calls = routeFetch([
      ["GET", /\/backups$/, ok([makeBackup({ id: ID(1) }), makeBackup({ id: ID(2), name: "second" })])],
      ["DELETE", /\/backups\//, ok({ jobId: JOB_ID }, 202)],
      ["GET", /\/jobs\//, ok({ ...job, type: "backup.delete", status: "succeeded", finishedAt: 2 })],
    ]);
    const user = userEvent.setup();
    wrap(<BackupsTab server={makeServer({ backupLimit: 3 })} me={makeMe()} />);
    await user.click(await screen.findByRole("button", { name: "Delete second" }));
    await user.click(
      within(await screen.findByRole("alertdialog")).getByRole("button", { name: "Delete backup" }),
    );
    await waitFor(() => expect(screen.queryByText("second")).toBeNull());
    expect(screen.getByText("1 / 3 used")).toBeTruthy();
    // The delete job is followed (here it succeeds): no notice, no re-read of the list.
    await waitFor(() => expect(calls.some((c) => c.url.endsWith(`/jobs/${JOB_ID}`))).toBe(true));
    expect(screen.queryByRole("alert")).toBeNull();
    expect(calls.filter((c) => c.method === "GET" && c.url.endsWith("/backups"))).toHaveLength(1);
  });

  it("a delete job that fails brings the backup back at once and says why", async () => {
    const backups = [makeBackup({ id: ID(1) }), makeBackup({ id: ID(2), name: "second" })];
    const calls = routeFetch([
      ["GET", /\/backups$/, ok(backups)],
      ["DELETE", /\/backups\//, ok({ jobId: JOB_ID }, 202)],
      [
        "GET",
        /\/jobs\//,
        ok({
          ...job,
          type: "backup.delete",
          status: "failed",
          finishedAt: 2,
          error: { code: "AGENT_ERROR", message: "permission denied removing the archive" },
        }),
      ],
    ]);
    const user = userEvent.setup();
    wrap(<BackupsTab server={makeServer({ backupLimit: 3 })} me={makeMe()} />);
    await user.click(await screen.findByRole("button", { name: "Delete second" }));
    await user.click(
      within(await screen.findByRole("alertdialog")).getByRole("button", { name: "Delete backup" }),
    );
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("Deleting “second” failed");
    expect(alert.textContent).toContain("permission denied removing the archive");
    // Tombstone lifted and the list re-read: the row and its slot are back without waiting for the TTL.
    expect(await screen.findByText("second")).toBeTruthy();
    expect(screen.getByText("2 / 3 used")).toBeTruthy();
    expect(calls.filter((c) => c.method === "GET" && c.url.endsWith("/backups"))).toHaveLength(2);
    await user.click(within(alert).getByRole("button", { name: "Dismiss" }));
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("locks, and deletes only after confirmation", async () => {
    const calls = routeFetch([
      ["GET", /\/backups$/, ok([makeBackup({ id: ID(1) })])],
      ["PATCH", /\/backups\//, ok(makeBackup({ id: ID(1), locked: true }))],
      ["DELETE", /\/backups\//, ok({ jobId: JOB_ID }, 202)],
    ]);
    const user = userEvent.setup();
    wrap(<BackupsTab server={makeServer()} me={makeMe()} />);
    await user.click(await screen.findByRole("button", { name: "Lock Before 1.21 update" }));
    await waitFor(() => expect(calls.find((c) => c.method === "PATCH")?.body).toEqual({ locked: true }));
    expect(await screen.findByRole("button", { name: "Unlock Before 1.21 update" })).toBeTruthy();
    // Locked: delete is disabled.
    expect(
      (screen.getByRole("button", { name: "Delete Before 1.21 update" }) as HTMLButtonElement).disabled,
    ).toBe(true);
  });

  it("asks before deleting", async () => {
    const calls = routeFetch([
      ["GET", /\/backups$/, ok([makeBackup({ id: ID(1) })])],
      ["DELETE", /\/backups\//, ok({ jobId: JOB_ID }, 202)],
    ]);
    const user = userEvent.setup();
    wrap(<BackupsTab server={makeServer()} me={makeMe()} />);
    await user.click(await screen.findByRole("button", { name: "Delete Before 1.21 update" }));
    const dialog = await screen.findByRole("alertdialog");
    expect(calls.some((c) => c.method === "DELETE")).toBe(false);
    await user.click(within(dialog).getByRole("button", { name: "Delete backup" }));
    await waitFor(() => expect(calls.some((c) => c.method === "DELETE")).toBe(true));
  });

  it("view-only users see backups without actions; a zero limit is explained", async () => {
    routeFetch([["GET", /\/backups$/, ok([makeBackup({ id: ID(1) })])]]);
    wrap(
      <BackupsTab
        server={makeServer({ myPermissions: ["servers.view", "servers.backups.view"] })}
        me={makeMe()}
      />,
    );
    await screen.findByText("Before 1.21 update");
    expect(screen.queryByRole("button", { name: "Create backup" })).toBeNull();
    expect(screen.queryByRole("button", { name: /^(Download|Restore|Delete|Lock) / })).toBeNull();
  });

  it("explains disabled backups to administrators", async () => {
    routeFetch([["GET", /\/backups$/, ok([])]]);
    wrap(
      <BackupsTab
        server={makeServer({ backupLimit: 0, myPermissions: [...owner, "servers.admin"] })}
        me={makeMe()}
      />,
    );
    expect((await screen.findAllByText("Backups are disabled for this server")).length).toBeGreaterThan(0);
    expect((screen.getByRole("button", { name: "Create backup" }) as HTMLButtonElement).disabled).toBe(true);
  });
});

// -------------------------------------------------------------------------------------------------

describe("Schedules tab", () => {
  const run = {
    id: "c0000000-0000-4000-8000-000000000001",
    scheduleId: makeSchedule().id,
    trigger: "cron",
    status: "failed",
    reason: null,
    startedAt: 1_760_000_000_000,
    finishedAt: 1_760_000_010_000,
    tasks: [
      {
        index: 0,
        action: "command",
        status: "succeeded",
        message: null,
        jobId: null,
        startedAt: 1,
        finishedAt: 2,
      },
      {
        index: 1,
        action: "power",
        status: "failed",
        message: "FORBIDDEN: the schedule's editor lost servers.control",
        jobId: JOB_ID,
        startedAt: 3,
        finishedAt: 4,
      },
    ],
  };

  it("lists schedules in words with next run in the schedule's zone and the last run's status", async () => {
    const s = makeSchedule({ lastRunAt: 1_760_000_000_000, lastRunStatus: "failed" });
    const calls = routeFetch([
      [
        "GET",
        /\/schedules$/,
        ok([s, makeSchedule({ id: ID(5), name: "Paused one", enabled: false, running: true })]),
      ],
    ]);
    wrap(<SchedulesTab server={makeServer()} />);
    expect(await screen.findByText("Nightly restart")).toBeTruthy();
    expect(screen.getAllByText("Every day at 04:00").length).toBeGreaterThan(0);
    expect(screen.getAllByText("0 4 * * *").length).toBeGreaterThan(0);
    expect(screen.getByText(formatInZone(s.nextRunAt!, "Europe/Berlin"))).toBeTruthy();
    expect(screen.getByText("Disabled")).toBeTruthy();
    expect(screen.getByText("Running")).toBeTruthy();
    expect(await screen.findByText("Failed")).toBeTruthy();
    expect(screen.getAllByText(/Restart the server after 300s/)).toHaveLength(2);
    // lastRunStatus comes with the schedule: no per-schedule runs request.
    expect(calls.some((c) => c.url.includes("/runs"))).toBe(false);
  });

  it("view-only users get no management controls", async () => {
    routeFetch([["GET", /\/schedules$/, ok([makeSchedule()])]]);
    wrap(<SchedulesTab server={makeServer({ myPermissions: ["servers.view", "schedules.view"] })} />);
    await screen.findByText("Nightly restart");
    expect(screen.queryByRole("button", { name: "New schedule" })).toBeNull();
    expect(screen.queryByRole("button", { name: /Run Nightly restart now/ })).toBeNull();
    expect(screen.queryByRole("switch")).toBeNull();
    expect(screen.getByRole("button", { name: "Run history of Nightly restart" })).toBeTruthy();
  });

  it("creates a schedule from a preset with a live preview", async () => {
    const created = makeSchedule({ id: ID(7), name: "Announce" });
    const calls = routeFetch([
      ["GET", /\/schedules$/, ok([])],
      [
        "POST",
        /\/schedules\/preview$/,
        (call) =>
          jsonResponse({
            valid: true,
            error: null,
            next: [Date.UTC(2026, 9, 12, 12, 15)],
            // Server-side description of what was asked.
            description:
              (call.body as { cron: { minute: string } }).cron.minute === "*/15"
                ? "Every 15 minutes"
                : "Other",
          }),
      ],
      ["POST", /\/servers\/.+\/schedules$/, ok(created, 201)],
    ]);
    const user = userEvent.setup();
    wrap(<SchedulesTab server={makeServer({ timezone: "UTC" })} />);
    await user.click(await screen.findByRole("button", { name: "New schedule" }));
    const dialog = await screen.findByRole("dialog");
    await user.type(within(dialog).getByLabelText(/^Name/), "Announce");
    await user.click(within(dialog).getByRole("button", { name: "Every 15 minutes" }));
    expect((within(dialog).getByLabelText("Minute") as HTMLInputElement).value).toBe("*/15");
    expect(
      await within(dialog).findByText("Every 15 minutes", { selector: "p" }, { timeout: 3000 }),
    ).toBeTruthy();
    const preview = calls.filter((c) => c.url.endsWith("/schedules/preview")).at(-1)!;
    expect(preview.body).toMatchObject({ cron: { minute: "*/15", hour: "*" }, timezone: "UTC", count: 5 });
    await user.type(within(dialog).getByLabelText("Command"), "say hello");
    await user.click(within(dialog).getByRole("button", { name: "Create schedule" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    const post = calls.find((c) => c.method === "POST" && /\/servers\/.+\/schedules$/.test(c.url))!;
    expect(post.body).toEqual({
      name: "Announce",
      cron: { minute: "*/15", hour: "*", dayOfMonth: "*", month: "*", dayOfWeek: "*" },
      timezone: "UTC",
      enabled: true,
      onlyWhenOnline: false,
      tasks: [{ action: "command", command: "say hello", offsetSeconds: 0, continueOnFailure: false }],
    });
  });

  it("blocks saving and enabling a schedule with a task the editor can't run, and validates", async () => {
    const calls = routeFetch([
      ["GET", /\/schedules$/, ok([makeSchedule()])],
      [
        "POST",
        /\/schedules\/preview$/,
        ok({ valid: false, error: "bad field", next: [], description: null }),
      ],
    ]);
    const user = userEvent.setup();
    wrap(
      <SchedulesTab
        server={makeServer({
          myPermissions: ["servers.view", "schedules.view", "schedules.manage", "servers.console.send"],
        })}
      />,
    );
    // The list's enable switch is disabled too (toggling would make this user the last editor).
    expect(
      ((await screen.findByRole("switch", { name: "Disable Nightly restart" })) as HTMLButtonElement)
        .disabled,
    ).toBe(true);
    await user.click(screen.getByRole("button", { name: "Edit Nightly restart" }));
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getAllByText(/You don't hold servers\.control/).length).toBeGreaterThan(0);
    const save = within(dialog).getByRole("button", { name: "Save schedule" }) as HTMLButtonElement;
    expect(save.disabled).toBe(true);
    expect(within(dialog).getByText(/Saving is disabled: Task 2/)).toBeTruthy();
    expect(await within(dialog).findByText("bad field", {}, { timeout: 3000 })).toBeTruthy();
    await user.click(within(dialog).getByRole("button", { name: "Remove task 2" }));
    // (The tooltip wrapper goes away with the reason, so query the button again.)
    const enabled = within(dialog).getByRole("button", { name: "Save schedule" }) as HTMLButtonElement;
    expect(enabled.disabled).toBe(false);
    await user.clear(within(dialog).getByLabelText(/^Name/));
    await user.click(enabled);
    expect(within(dialog).getByText(/Give the schedule a name/)).toBeTruthy();
    expect(calls.some((c) => c.method === "PUT")).toBe(false);
  });

  it("starts a new schedule with a task type the user can run", async () => {
    routeFetch([
      ["GET", /\/schedules$/, ok([])],
      ["POST", /\/schedules\/preview$/, ok({ valid: true, error: null, next: [], description: null })],
    ]);
    const user = userEvent.setup();
    wrap(
      <SchedulesTab
        server={makeServer({
          myPermissions: ["servers.view", "schedules.view", "schedules.manage", "servers.control"],
        })}
      />,
    );
    await user.click(await screen.findByRole("button", { name: "New schedule" }));
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByRole("combobox", { name: "Task 1 type" }).textContent).toContain(
      "Power action",
    );
    expect(within(dialog).queryByText(/You don't hold/)).toBeNull();
  });

  it("never shows runs computed for a previous zone or expression", async () => {
    let release: () => void = () => {};
    routeFetch([
      ["GET", /\/schedules$/, ok([])],
      [
        "POST",
        /\/schedules\/preview$/,
        (call) => {
          const tz = (call.body as { timezone: string }).timezone;
          const body = {
            valid: true,
            error: null,
            next: [Date.UTC(2026, 9, 13, 4, 0)],
            description: `in ${tz}`,
          };
          if (tz === "UTC") return jsonResponse(body);
          // The second zone's answer is held back to observe the in-between state.
          return new Promise<Response>((r) => (release = () => r(jsonResponse(body))));
        },
      ],
    ]);
    const user = userEvent.setup();
    wrap(<SchedulesTab server={makeServer({ timezone: "UTC" })} />);
    await user.click(await screen.findByRole("button", { name: "New schedule" }));
    const dialog = await screen.findByRole("dialog");
    expect(await within(dialog).findByText("in UTC", {}, { timeout: 3000 })).toBeTruthy();
    const zone = within(dialog).getByLabelText(/^Time zone/);
    await user.clear(zone);
    await user.type(zone, "Asia/Tokyo");
    expect(within(dialog).queryByText("in UTC")).toBeNull();
    expect(within(dialog).getByText("Checking…")).toBeTruthy();
    // After the debounce the new zone's request is in flight; its answer is the only one shown.
    await new Promise((r) => setTimeout(r, 450));
    expect(within(dialog).queryByText("in UTC")).toBeNull();
    release();
    expect(await within(dialog).findByText("in Asia/Tokyo", {}, { timeout: 3000 })).toBeTruthy();
  });

  it("polls the open run history while the schedule is running", async () => {
    const calls = routeFetch([
      ["GET", /\/schedules$/, ok([makeSchedule({ running: true, lastRunAt: 1 })])],
      ["GET", /\/runs/, ok({ items: [run], nextCursor: null })],
    ]);
    const user = userEvent.setup();
    wrap(<SchedulesTab server={makeServer()} />);
    await user.click(await screen.findByRole("button", { name: "Run history of Nightly restart" }));
    await waitFor(
      () => expect(calls.filter((c) => c.url.includes("/runs")).length).toBeGreaterThanOrEqual(2),
      {
        timeout: 4500,
      },
    );
  }, 8000);

  it("toggles, runs now and shows run history with per-task results", async () => {
    const s = makeSchedule({ lastRunAt: 1_760_000_000_000 });
    const calls = routeFetch([
      ["GET", /\/schedules$/, ok([s])],
      ["PUT", /\/schedules\//, ok({ ...s, enabled: false })],
      ["POST", /\/run$/, ok({ ...run, trigger: "manual", status: "running" }, 202)],
      ["GET", /\/runs/, ok({ items: [run], nextCursor: null })],
    ]);
    const user = userEvent.setup();
    wrap(<SchedulesTab server={makeServer()} />);
    await user.click(await screen.findByRole("switch", { name: "Disable Nightly restart" }));
    await waitFor(() =>
      expect(calls.find((c) => c.method === "PUT")?.body).toMatchObject({ enabled: false }),
    );
    expect((calls.find((c) => c.method === "PUT")!.body as { tasks: unknown[] }).tasks).toHaveLength(2);
    await user.click(screen.getByRole("button", { name: "Run Nightly restart now" }));
    await waitFor(() => expect(calls.some((c) => c.url.endsWith("/run"))).toBe(true));
    await user.click(screen.getByRole("button", { name: "Run history of Nightly restart" }));
    const dialog = await screen.findByRole("dialog");
    expect(await within(dialog).findByText(/editor lost servers\.control/)).toBeTruthy();
    expect(within(dialog).getByRole("button", { name: "View job" })).toBeTruthy();
  });
});

describe("sidebar", () => {
  it("per-server sections link to the server list", async () => {
    const root = createRootRoute({ component: () => <SidebarNav me={makeMe()} /> });
    const router = createRouter({ routeTree: root, history: createMemoryHistory({ initialEntries: ["/"] }) });
    wrap(<RouterProvider router={router} />);
    const backups = await screen.findByRole("link", { name: /Backups/ });
    expect(backups.getAttribute("href")).toBe("/servers");
    expect(screen.getByRole("link", { name: /Schedules & Tasks/ }).getAttribute("href")).toBe("/servers");
  });
});

describe("Resources panel ping", () => {
  const latest = (latencyMs?: number) => ({
    workloadId: SERVER_ID,
    ts: Date.now(),
    running: true,
    ...(latencyMs === undefined
      ? {}
      : { minecraft: { playersOnline: 1, playersMax: 20, latencyMs, playerSample: [] } }),
  });
  const ping = () => screen.getByText("Ping (status query)").parentElement!.textContent;

  it("shows sub-millisecond status queries as < 1 ms and a missing value as —", () => {
    const { unmount } = render(
      <TooltipProvider>
        <ServerLiveStats server={makeServer({ latest: latest(0.4) })} />
      </TooltipProvider>,
    );
    expect(ping()).toContain("< 1 ms");
    unmount();
    const second = render(
      <TooltipProvider>
        <ServerLiveStats server={makeServer({ latest: latest() })} />
      </TooltipProvider>,
    );
    expect(ping()).toContain("—");
    second.unmount();
    render(
      <TooltipProvider>
        <ServerLiveStats server={makeServer({ game: "other", latest: latest() })} />
      </TooltipProvider>,
    );
    expect(screen.queryByText("Ping (status query)")).toBeNull();
  });
});
