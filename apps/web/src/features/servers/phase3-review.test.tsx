import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  RouterProvider,
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
} from "@tanstack/react-router";
import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { IDEMPOTENCY_HEADER, SERVER_JOB_ERROR_CODES, SERVER_OWNER_PERMISSIONS } from "@blockforge/contracts";
import type { Job, Permission } from "@blockforge/contracts";
import { SERVER_ID, apiErrorBody, jsonResponse, makeServer } from "@/test/fixtures";
import { ApiError } from "@/lib/api/errors";
import { downloadText } from "@/lib/download";
import { IdempotencyKeys, isUncertainFailure } from "@/lib/idempotency";
import { describeJobError } from "@/lib/job-errors";
import { SUBUSER_PERMISSION_GROUPS, defaultSubuserGrant } from "@/lib/server-permissions";
import { ThemeProvider } from "@/lib/theme";
import { TooltipProvider } from "@/components/ui/tooltip";
import { DISCARD_PROMPT, leavesEditor, shouldBlockEditorLeave } from "./editor-guard";
import { JobErrorNotice, PowerControls, PowerJobNotice, StateHint } from "./server-common";
import { serverCardSnapshot } from "./server-card-snapshot";
import { parseServerSearch } from "./server-search";
import { DeleteCard } from "./tabs/settings-tab";
import { PermissionMatrix } from "./tabs/users-tab";

const JOB_ID = "77777777-7777-4777-8777-777777777777";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

/** Renders `ui` at "/" inside a router (with a /servers route) and the app providers. */
function renderApp(ui: () => ReactNode) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const root = createRootRoute();
  const home = createRoute({ getParentRoute: () => root, path: "/", component: ui });
  const list = createRoute({
    getParentRoute: () => root,
    path: "/servers",
    component: () => <p>Server list</p>,
  });
  const router = createRouter({
    routeTree: root.addChildren([home, list]),
    history: createMemoryHistory({ initialEntries: ["/"] }),
  });
  render(
    <ThemeProvider>
      <QueryClientProvider client={qc}>
        <TooltipProvider>
          <RouterProvider router={router} />
        </TooltipProvider>
      </QueryClientProvider>
    </ThemeProvider>,
  );
  return { qc, router };
}

type Call = { url: string; method: string; key: string | undefined };
function stubFetch(responses: Array<() => Response | Promise<Response>>) {
  const calls: Call[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init: RequestInit = {}) => {
      const headers = (init.headers ?? {}) as Record<string, string>;
      calls.push({ url, method: init.method ?? "GET", key: headers[IDEMPOTENCY_HEADER] });
      const next = responses.shift();
      if (!next) throw new Error(`unexpected request ${url}`);
      return next();
    }),
  );
  return calls;
}
const networkDown = () => Promise.reject(new TypeError("Failed to fetch"));
const accepted = () => jsonResponse({ jobId: JOB_ID }, { status: 202 });

// -------------------------------------------------------------------------------------------------

describe("idempotency keys (#1, #2)", () => {
  let n = 0;
  const mint = () => `key-${++n}`;
  const definitive = new ApiError({ code: "CONFLICT", message: "busy", status: 409 });
  const network = new ApiError({ code: "NETWORK_ERROR", message: "offline", status: 0 });
  const server = new ApiError({ code: "INTERNAL", message: "boom", status: 503 });

  it("classifies uncertain failures", () => {
    expect(isUncertainFailure(network)).toBe(true);
    expect(isUncertainFailure(server)).toBe(true);
    expect(isUncertainFailure(new Error("parse"))).toBe(true);
    expect(isUncertainFailure(definitive)).toBe(false);
  });

  it("keeps a key until the outcome is known, then rotates", () => {
    const keys = new IdempotencyKeys<"start" | "stop">(mint);
    const k1 = keys.sent("start");
    expect(keys.isLocked("start")).toBe(true);
    keys.settle("start", { ok: false, error: network });
    expect(keys.sent("start")).toBe(k1); // retry replays
    keys.settle("start", { ok: false, error: server });
    expect(keys.sent("start")).toBe(k1);
    keys.settle("start", { ok: true });
    expect(keys.isLocked("start")).toBe(false);
    const k2 = keys.sent("start");
    expect(k2).not.toBe(k1);
    keys.settle("start", { ok: false, error: definitive });
    expect(keys.sent("start")).not.toBe(k2);
    // One key per action.
    expect(keys.keyFor("stop")).not.toBe(keys.keyFor("start"));
  });

  it("invalidate() rotates an idle key but never one that is in flight", () => {
    const keys = new IdempotencyKeys<"delete">(mint);
    const k1 = keys.keyFor("delete");
    keys.invalidate("delete");
    const k2 = keys.keyFor("delete");
    expect(k2).not.toBe(k1);
    keys.sent("delete");
    keys.invalidate("delete");
    expect(keys.keyFor("delete")).toBe(k2);
  });
});

describe("DeleteCard (#1)", () => {
  const stopped = () =>
    makeServer({
      state: "stopped",
      desiredState: "stopped",
      myPermissions: [...SERVER_OWNER_PERMISSIONS, "servers.delete"],
    });

  async function submit(user: ReturnType<typeof userEvent.setup>) {
    const dialog = await screen.findByRole("alertdialog");
    const confirm = within(dialog).getByLabelText(/to confirm/);
    if ((confirm as HTMLInputElement).value === "") await user.type(confirm, "Survival");
    await user.click(within(dialog).getByRole("button", { name: "Delete server" }));
  }

  it("mints a new key when 'also delete files' changes after a rejected request", async () => {
    const calls = stubFetch([() => jsonResponse(apiErrorBody("CONFLICT"), { status: 409 }), accepted]);
    const user = userEvent.setup();
    renderApp(() => <DeleteCard server={stopped()} />);
    await user.click(await screen.findByRole("button", { name: "Delete…" }));
    await submit(user);
    await waitFor(() => expect(calls).toHaveLength(1));
    expect(calls[0]!.url).toContain("deleteData=true");
    const box = screen.getByRole("checkbox", { name: /Also delete the server's files/ });
    await waitFor(() => expect((box as HTMLButtonElement).disabled).toBe(false));
    await user.click(box);
    await submit(user);
    await waitFor(() => expect(calls).toHaveLength(2));
    expect(calls[1]!.url).not.toContain("deleteData");
    expect(calls[1]!.key).toBeTruthy();
    expect(calls[1]!.key).not.toBe(calls[0]!.key);
  });

  it("freezes the choice and replays the same key after an uncertain failure", async () => {
    const calls = stubFetch([networkDown, accepted]);
    const user = userEvent.setup();
    renderApp(() => <DeleteCard server={stopped()} />);
    await user.click(await screen.findByRole("button", { name: "Delete…" }));
    const box = screen.getByRole("checkbox", { name: /Also delete the server's files/ });
    await user.click(box); // keep the files
    await submit(user);
    await waitFor(() => expect(calls).toHaveLength(1));
    await waitFor(() => expect((box as HTMLButtonElement).disabled).toBe(true));
    expect(screen.getByRole("status").textContent).toMatch(/keeping the files/);
    await user.click(box); // ignored while locked
    await submit(user);
    await waitFor(() => expect(calls).toHaveLength(2));
    expect(calls[1]!.key).toBe(calls[0]!.key);
    expect(calls[1]!.url).toBe(calls[0]!.url);
    expect(calls[1]!.url).not.toContain("deleteData");
  });
});

describe("PowerControls (#2)", () => {
  it("retries replay the same key; a settled action gets a fresh one", async () => {
    const calls = stubFetch([networkDown, accepted, accepted]);
    const user = userEvent.setup();
    const onJob = vi.fn();
    renderApp(() => <PowerControls server={makeServer({ state: "stopped" })} onJob={onJob} />);
    const start = await screen.findByRole("button", { name: "Start" });
    await user.click(start);
    await waitFor(() => expect(calls).toHaveLength(1));
    await waitFor(() => expect((start as HTMLButtonElement).disabled).toBe(false));
    await user.click(start);
    await waitFor(() => expect(onJob).toHaveBeenCalledWith(JOB_ID, "start"));
    expect(calls[1]!.key).toBe(calls[0]!.key);
    await waitFor(() => expect((start as HTMLButtonElement).disabled).toBe(false));
    await user.click(start);
    await waitFor(() => expect(calls).toHaveLength(3));
    expect(calls[2]!.key).not.toBe(calls[0]!.key);
  });
});

// -------------------------------------------------------------------------------------------------

describe("subuser permission matrix (#5, #16)", () => {
  const granter: Permission[] = ["servers.view", "servers.files.read", "servers.subusers.manage"];

  it("seeds a new subuser only with what the granter can grant", () => {
    expect(defaultSubuserGrant(granter)).toEqual(["servers.view"]);
    expect(defaultSubuserGrant(["servers.view", "servers.console.view"])).toEqual([
      "servers.view",
      "servers.console.view",
    ]);
  });

  it("never shows an ungrantable permission as granted (unless the subuser already holds it)", () => {
    const value = new Set<Permission>(["servers.view", "servers.console.view"]);
    const { unmount } = render(<PermissionMatrix value={value} onChange={() => {}} granter={granter} />);
    const consoleView = screen.getByRole("checkbox", { name: /Read the live console/ });
    expect(consoleView.getAttribute("aria-checked")).toBe("false");
    expect((consoleView as HTMLButtonElement).disabled).toBe(true);
    unmount();
    render(
      <PermissionMatrix
        value={value}
        onChange={() => {}}
        granter={granter}
        existing={["servers.view", "servers.console.view"]}
      />,
    );
    expect(screen.getByRole("checkbox", { name: /Read the live console/ }).getAttribute("aria-checked")).toBe(
      "true",
    );
  });

  it("labels permission groups whose pages don't exist yet as API-only", () => {
    render(<PermissionMatrix value={new Set()} onChange={() => {}} granter={granter} />);
    const pending = SUBUSER_PERMISSION_GROUPS.filter((g) => g.uiPhase);
    expect(pending.map((g) => g.id)).toEqual(expect.arrayContaining(["backups", "schedules"]));
    expect(screen.getAllByText(/^API only · UI in Phase \d$/)).toHaveLength(pending.length);
  });
});

// -------------------------------------------------------------------------------------------------

describe("editor guard (#9)", () => {
  const at = (tab?: string, edit?: string, pathname = `/servers/${SERVER_ID}`) => ({
    pathname,
    search: { tab, edit },
  });

  it("knows which navigations close the editor", () => {
    expect(leavesEditor(at("files", "a.yml"), at("files", "a.yml"))).toBe(false);
    expect(leavesEditor(at("files", "a.yml"), at("console"))).toBe(true);
    expect(leavesEditor(at("files", "a.yml"), at("files", "b.yml"))).toBe(true);
    expect(leavesEditor(at("files", "a.yml"), at("files", "a.yml", "/servers"))).toBe(true);
  });

  it("asks only when dirty, blocks on cancel and clears the flag on discard", () => {
    const confirm = vi.fn(() => false);
    const dirty = { current: false };
    expect(shouldBlockEditorLeave(dirty, at("files", "a"), at("console"), confirm)).toBe(false);
    expect(confirm).not.toHaveBeenCalled();
    dirty.current = true;
    expect(shouldBlockEditorLeave(dirty, at("files", "a"), at("files", "a"), confirm)).toBe(false);
    expect(confirm).not.toHaveBeenCalled();
    expect(shouldBlockEditorLeave(dirty, at("files", "a"), at("console"), confirm)).toBe(true);
    expect(confirm).toHaveBeenCalledWith(DISCARD_PROMPT);
    expect(dirty.current).toBe(true);
    confirm.mockReturnValue(true);
    expect(shouldBlockEditorLeave(dirty, at("files", "a"), at("console"), confirm)).toBe(false);
    expect(dirty.current).toBe(false);
  });
});

describe("server page search params (#15)", () => {
  it("keeps valid relative paths and drops anything else", () => {
    expect(
      parseServerSearch({ tab: "files", path: "plugins/Essentials", edit: "server.properties" }),
    ).toEqual({
      tab: "files",
      path: "plugins/Essentials",
      edit: "server.properties",
      range: undefined,
    });
    for (const bad of ["../etc", "a/../../b", "/etc/passwd", "C:\\Windows", "a\0b", "x".repeat(1025), 42]) {
      expect(parseServerSearch({ path: bad, edit: bad })).toMatchObject({ path: undefined, edit: undefined });
    }
    // The data root can be browsed but not opened in the editor.
    expect(parseServerSearch({ path: ".", edit: "./" })).toMatchObject({ path: ".", edit: undefined });
    expect(parseServerSearch({ tab: "nope", range: "y".repeat(65) })).toMatchObject({
      tab: undefined,
      range: undefined,
    });
  });
});

// -------------------------------------------------------------------------------------------------

describe("crash info and job errors (lastOomKilled, SERVER_JOB_ERROR_CODES)", () => {
  const hint = (overrides: Parameters<typeof makeServer>[0]) =>
    render(
      <TooltipProvider>
        <StateHint server={makeServer(overrides)} />
      </TooltipProvider>,
    ).container;

  it("marks out-of-memory exits", () => {
    expect(
      hint({ state: "crashed", lastCrashAt: 1_700_000_000_000, lastExitCode: 137, lastOomKilled: true })
        .textContent,
    ).toMatch(/Crashed .* · exit 137 · out of memory/);
    expect(hint({ state: "stopped", lastOomKilled: true }).textContent).toBe("Last exit: out of memory");
    expect(hint({ state: "running", lastOomKilled: true }).textContent).toBe("");
    expect(
      hint({ state: "crashed", lastCrashAt: 1_700_000_000_000, lastExitCode: 1 }).textContent,
    ).not.toMatch(/memory/);
  });

  it("describes every classified job error code", () => {
    for (const code of Object.keys(SERVER_JOB_ERROR_CODES)) {
      expect(describeJobError(code).description).toBe(
        SERVER_JOB_ERROR_CODES[code as keyof typeof SERVER_JOB_ERROR_CODES],
      );
    }
    expect(describeJobError("toString")).toEqual({ description: null, hint: null });
    expect(describeJobError("SOMETHING_ELSE").description).toBeNull();
  });

  it("renders the description, the raw message as text, and a hint", () => {
    const { container } = render(
      <JobErrorNotice
        title="Start failed"
        error={{ code: "EULA_NOT_ACCEPTED", message: "<b>You need to agree</b>" }}
      />,
    );
    const alert = screen.getByRole("alert");
    expect(alert.textContent).toContain(`Start failed: ${SERVER_JOB_ERROR_CODES.EULA_NOT_ACCEPTED}`);
    expect(alert.textContent).toContain("<b>You need to agree</b>");
    expect(container.querySelector("b")).toBeNull();
    expect(alert.textContent).toMatch(/Accept the EULA/);
  });

  it("follows a power job and reports its failure", async () => {
    const failed: Job = {
      id: JOB_ID,
      type: "server.start",
      status: "failed",
      targetType: "server",
      targetId: SERVER_ID,
      requestedBy: null,
      attempts: 1,
      error: { code: "OOM_KILLED", message: "exit 137" },
      result: null,
      createdAt: 1,
      startedAt: 1,
      finishedAt: 2,
      steps: [],
    };
    stubFetch([() => jsonResponse(failed)]);
    const onFailed = vi.fn();
    const onDismiss = vi.fn();
    renderApp(() => (
      <PowerJobNotice jobId={JOB_ID} action="start" onFailed={onFailed} onDismiss={onDismiss} />
    ));
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain(`Start failed: ${SERVER_JOB_ERROR_CODES.OOM_KILLED}`);
    expect(onFailed).toHaveBeenCalledWith("OOM_KILLED");
    await act(async () => within(alert).getByRole("button", { name: "Dismiss" }).click());
    expect(onDismiss).toHaveBeenCalled();
  });
});

// -------------------------------------------------------------------------------------------------

describe("dashboard card memoisation (#17)", () => {
  it("ignores updates that change nothing the card shows", () => {
    const a = makeServer({ latest: null });
    const b = makeServer({ latest: null, lastStartedAt: 1_700_000_100_000, desiredState: "stopped" });
    expect(serverCardSnapshot(b)).toBe(serverCardSnapshot(a));
    expect(serverCardSnapshot(makeServer({ state: "stopping" }))).not.toBe(serverCardSnapshot(a));
    expect(serverCardSnapshot(makeServer({ name: "Creative" }))).not.toBe(serverCardSnapshot(a));
  });
});

describe("downloadText (#13)", () => {
  it("clicks an anchor attached to the document, then removes it and revokes the URL", () => {
    vi.useFakeTimers();
    const createObjectURL = vi.fn(() => "blob:test");
    const revokeObjectURL = vi.fn();
    vi.stubGlobal("URL", Object.assign(URL, { createObjectURL, revokeObjectURL }));
    let attached = false;
    let name = "";
    vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(function (this: HTMLAnchorElement) {
      attached = this.isConnected;
      name = this.download;
    });
    downloadText("console.log", "hello");
    expect(attached).toBe(true);
    expect(name).toBe("console.log");
    expect(document.querySelector("a[download]")).toBeNull();
    expect(revokeObjectURL).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1_000);
    expect(revokeObjectURL).toHaveBeenCalledWith("blob:test");
  });
});
