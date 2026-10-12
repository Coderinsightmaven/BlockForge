import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { RouterProvider, createMemoryHistory, createRootRoute, createRouter } from "@tanstack/react-router";
import { render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { OverviewSummary } from "@blockforge/contracts";
import { makeMe } from "@/test/fixtures";
import { qk } from "@/lib/query-keys";
import { ThemeProvider } from "@/lib/theme";
import { TooltipProvider } from "@/components/ui/tooltip";
import { EnrollmentDialogProvider } from "@/features/nodes/enrollment-dialog";
import { OverviewPage } from "./overview-page";

const GiB = 1024 ** 3;

function summary(overrides: Partial<OverviewSummary> = {}): OverviewSummary {
  return {
    generatedAt: Date.now(),
    nodes: { total: 2, online: 2, degraded: 0, unreachable: 0, offline: 0, pending: 0 },
    servers: { total: 0, byState: {} },
    players: { online: 0, reportingServers: 0 },
    cpu: { capacityMillicores: 16_000, allocatedMillicores: 8000, usagePct: 25 },
    memory: { totalBytes: 64 * GiB, allocatedBytes: 32 * GiB, usedBytes: 10 * GiB, availableBytes: 50 * GiB },
    storage: { totalBytes: null, usedBytes: null },
    network: { rxBytesPerSec: null, txBytesPerSec: null },
    backups: null,
    pendingUpdates: null,
    activeAlerts: { critical: 0, warning: 0, info: 0 },
    recentCrashes: [],
    recentFailedJobs: [],
    ...overrides,
  };
}

async function renderOverview(
  data: OverviewSummary,
  permissions = ["monitoring.view", "nodes.enroll"] as const,
) {
  // Metric range requests stay pending: the charts show loading placeholders.
  vi.stubGlobal(
    "fetch",
    vi.fn(() => new Promise<Response>(() => {})),
  );
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  qc.setQueryData(qk.overview, data);
  const me = makeMe({ permissions: [...permissions] });
  const root = createRootRoute({
    component: () => (
      <EnrollmentDialogProvider>
        <OverviewPage me={me} range={{ kind: "relative", preset: "1h" }} onRangeChange={() => {}} />
      </EnrollmentDialogProvider>
    ),
  });
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
  await screen.findByText("Overview");
}

afterEach(() => vi.unstubAllGlobals());

describe("OverviewPage", () => {
  it("shows allocation and actual usage as separate, labelled measurements", async () => {
    await renderOverview(summary());
    expect(screen.getAllByText("Allocated to servers")).toHaveLength(2);
    expect(screen.getAllByText("Actually in use")).toHaveLength(2);
    expect(screen.getByText("32.0 GiB")).toBeTruthy(); // allocated memory
    expect(screen.getByText("10.0 GiB")).toBeTruthy(); // used memory
    expect(screen.getAllByRole("meter", { name: "Actually in use" })).toHaveLength(2);
    expect(screen.getAllByRole("meter", { name: "Allocated to servers" })).toHaveLength(2);
  });

  it("renders missing data explicitly instead of zeros", async () => {
    await renderOverview(
      summary({ memory: { totalBytes: 64 * GiB, allocatedBytes: 0, usedBytes: null, availableBytes: null } }),
    );
    expect(screen.getByText(/Not configured yet/)).toBeTruthy();
    expect(screen.getByText(/Not tracked yet/)).toBeTruthy();
    expect(screen.getAllByText("No data").length).toBeGreaterThanOrEqual(3);
  });

  it("offers to enroll the first node when there are none", async () => {
    await renderOverview(
      summary({ nodes: { total: 0, online: 0, degraded: 0, unreachable: 0, offline: 0, pending: 0 } }),
    );
    expect(screen.getByText("No nodes enrolled yet")).toBeTruthy();
    expect(screen.getByRole("button", { name: /Enroll first node/ })).toBeTruthy();
  });

  it("warns when allocations exceed physical memory", async () => {
    await renderOverview(
      summary({
        memory: {
          totalBytes: 16 * GiB,
          allocatedBytes: 24 * GiB,
          usedBytes: 4 * GiB,
          availableBytes: 12 * GiB,
        },
      }),
    );
    expect(screen.getByText(/overcommitted/)).toBeTruthy();
  });
});
