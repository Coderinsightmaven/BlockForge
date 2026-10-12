import { QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { jsonResponse } from "@/test/fixtures";
import { createQueryClient } from "@/lib/queries";
import { ThemeProvider } from "@/lib/theme";
import { TooltipProvider } from "@/components/ui/tooltip";
import { EnrollmentDialogProvider, useEnrollmentDialog } from "./enrollment-dialog";

const SECRET = "bf_enroll_SECRET_9f8e7d6c5b4a";
const created = {
  token: {
    id: "44444444-4444-4444-8444-444444444444",
    tokenId: "et_7Hq2",
    label: "fra-node-03",
    expiresAt: Date.now() + 3_600_000,
    usedAt: null,
    usedByNodeId: null,
    requiresApproval: true,
    createdAt: Date.now(),
    createdBy: "Test Owner",
  },
  secretToken: SECRET,
  installCommand: `curl -fsSL https://cp.example.test/install.sh | sudo sh -s -- --token ${SECRET}`,
};

function Opener() {
  const { open } = useEnrollmentDialog();
  return (
    <button type="button" onClick={open}>
      open enrollment
    </button>
  );
}

afterEach(() => vi.unstubAllGlobals());

describe("EnrollmentDialog", () => {
  it("shows the secret once and keeps no copy in the mutation cache", async () => {
    const requests: Array<{ url: string; body: unknown }> = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init: RequestInit) => {
        requests.push({ url, body: init.body ? JSON.parse(String(init.body)) : undefined });
        return jsonResponse(created);
      }),
    );
    const qc = createQueryClient();
    const dumpMutations = () =>
      JSON.stringify(
        qc
          .getMutationCache()
          .getAll()
          .map((m) => m.state),
      );
    const user = userEvent.setup();
    render(
      <ThemeProvider>
        <QueryClientProvider client={qc}>
          <TooltipProvider>
            <EnrollmentDialogProvider>
              <Opener />
            </EnrollmentDialogProvider>
          </TooltipProvider>
        </QueryClientProvider>
      </ThemeProvider>,
    );

    await user.click(screen.getByRole("button", { name: "open enrollment" }));
    // The dialog is its own chunk, loaded on first open.
    await user.type(await screen.findByLabelText(/^Label/), "fra-node-03");
    await user.click(screen.getByRole("button", { name: "Create token" }));

    await screen.findByText("Enrollment token created");
    expect(requests[0]).toMatchObject({
      url: "/api/v1/nodes/enrollment-tokens",
      body: { label: "fra-node-03", requiresApproval: true },
    });
    expect((screen.getByLabelText("Enrollment token") as HTMLInputElement).value).toBe(SECRET);
    // While it is displayed the secret lives only in the dialog's state, not in TanStack's cache.
    await waitFor(() => expect(dumpMutations()).not.toContain(SECRET));

    await user.click(screen.getByRole("button", { name: "Done" }));
    await waitFor(() => expect(screen.queryByText("Enrollment token created")).toBeNull());
    expect(document.body.textContent).not.toContain(SECRET);
    expect(dumpMutations()).not.toContain(SECRET);
    expect(qc.getMutationCache().getAll()).toHaveLength(0);
  });
});
