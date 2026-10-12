import { QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { NODE_ID, jsonResponse, makeNode } from "@/test/fixtures";
import { createQueryClient } from "@/lib/queries";
import { ThemeProvider } from "@/lib/theme";
import { TooltipProvider } from "@/components/ui/tooltip";
import { PendingBanner } from "./node-detail-page";

afterEach(() => vi.unstubAllGlobals());

describe("PendingBanner", () => {
  it("asks for confirmation before approving", async () => {
    const pending = makeNode({ status: "pending" });
    const fetchStub = vi.fn(async () => jsonResponse({ ...pending, status: "active" }));
    vi.stubGlobal("fetch", fetchStub);
    const user = userEvent.setup();
    render(
      <ThemeProvider>
        <QueryClientProvider client={createQueryClient()}>
          <TooltipProvider>
            <PendingBanner node={pending} canManage />
          </TooltipProvider>
        </QueryClientProvider>
      </ThemeProvider>,
    );

    await user.click(screen.getByRole("button", { name: "Approve…" }));
    expect(await screen.findByText(`Approve ${pending.name}?`)).toBeTruthy();
    expect(fetchStub).not.toHaveBeenCalled();

    await user.click(screen.getByRole("button", { name: "Approve" }));
    await waitFor(() => expect(fetchStub).toHaveBeenCalledTimes(1));
    expect((fetchStub.mock.calls[0] as unknown as [string])[0]).toBe(`/api/v1/nodes/${NODE_ID}/approve`);
  });

  it("offers no approve action without nodes.manage", () => {
    render(
      <ThemeProvider>
        <QueryClientProvider client={createQueryClient()}>
          <TooltipProvider>
            <PendingBanner node={makeNode({ status: "pending" })} canManage={false} />
          </TooltipProvider>
        </QueryClientProvider>
      </ThemeProvider>,
    );
    expect(screen.queryByRole("button", { name: /Approve/ })).toBeNull();
  });
});
