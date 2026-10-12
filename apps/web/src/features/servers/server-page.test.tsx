import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { RouterProvider, createMemoryHistory, createRootRoute, createRouter } from "@tanstack/react-router";
import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Server } from "@blockforge/contracts";
import { JOB_ID, SERVER_ID, apiErrorBody, jsonResponse, makeMe, makeServer } from "@/test/fixtures";
import { DEFAULT_TIME_RANGE } from "@/lib/time-range";
import { TooltipProvider } from "@/components/ui/tooltip";
import { ServerPage } from "./server-page";

/*
 * The server page's first load is the frame + console; tabs and job widgets are separate chunks.
 * The mocked modules below record when their chunk is requested (the factory runs on first import).
 */
const chunks = vi.hoisted(() => {
  let release!: () => void;
  const jobsGate = new Promise<void>((resolve) => (release = resolve));
  return { loaded: new Set<string>(), jobsGate, releaseJobs: () => release() };
});

vi.mock("./console/console-panel", () => ({ ConsolePanel: () => <p>console panel</p> }));
vi.mock("./tabs/backups-tab", () => {
  chunks.loaded.add("backups");
  return { default: () => <p>backups tab</p> };
});
vi.mock("./tabs/activity-tab", () => {
  chunks.loaded.add("activity");
  return { default: () => <p>activity tab</p> };
});
vi.mock("./server-jobs", async () => {
  chunks.loaded.add("jobs");
  await chunks.jobsGate;
  return {
    JobProgress: ({ jobId, title }: { jobId: string; title: string }) => (
      <p>
        {title} progress for {jobId}
      </p>
    ),
    PowerJobNotice: () => null,
  };
});

afterEach(() => vi.unstubAllGlobals());

function renderPage(server: Server) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) =>
      new RegExp(`/servers/${SERVER_ID}$`).test(url)
        ? jsonResponse(server)
        : jsonResponse(apiErrorBody("NOT_FOUND"), { status: 404 }),
    ),
  );
  const onSearch = vi.fn();
  const root = createRootRoute({
    component: () => (
      <ServerPage
        me={makeMe()}
        serverId={SERVER_ID}
        search={{}}
        range={DEFAULT_TIME_RANGE}
        onSearch={onSearch}
        onRangeChange={() => {}}
      />
    ),
  });
  const router = createRouter({ routeTree: root, history: createMemoryHistory({ initialEntries: ["/"] }) });
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={qc}>
      <TooltipProvider>
        <RouterProvider router={router} />
      </TooltipProvider>
    </QueryClientProvider>,
  );
  return { onSearch };
}

describe("server page loading", () => {
  it("prefetches a tab's chunk when its trigger is hovered or focused, without switching tabs", async () => {
    const user = userEvent.setup();
    const { onSearch } = renderPage(makeServer());
    expect(await screen.findByText("console panel")).toBeTruthy();
    expect(chunks.loaded.has("backups")).toBe(false);
    expect(chunks.loaded.has("activity")).toBe(false);

    await user.hover(screen.getByRole("tab", { name: "Backups" }));
    await waitFor(() => expect(chunks.loaded.has("backups")).toBe(true));
    expect(onSearch).not.toHaveBeenCalled();
    expect(screen.getByRole("tab", { name: "Console" }).getAttribute("aria-selected")).toBe("true");

    act(() => screen.getByRole("tab", { name: "Activity" }).focus());
    await waitFor(() => expect(chunks.loaded.has("activity")).toBe(true));
  });

  it("shows a running job as loading (title, no progress) until its widget's chunk arrives", async () => {
    renderPage(makeServer({ state: "provisioning", activeOperation: "provision", activeJobId: JOB_ID }));
    expect(await screen.findByText("Loading job…")).toBeTruthy();
    expect(screen.getByText("Installing server")).toBeTruthy();
    expect(screen.queryByText(/steps/)).toBeNull();
    expect(chunks.loaded.has("jobs")).toBe(true);

    await act(async () => {
      chunks.releaseJobs();
      await chunks.jobsGate;
    });
    expect(await screen.findByText(`Installing server progress for ${JOB_ID}`)).toBeTruthy();
    expect(screen.queryByText("Loading job…")).toBeNull();
  });
});
