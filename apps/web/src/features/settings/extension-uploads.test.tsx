import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Permission } from "@blockforge/contracts";
import { apiErrorBody, jsonResponse, makeMe } from "@/test/fixtures";
import { ThemeProvider } from "@/lib/theme";
import ExtensionUploadsCard from "./extension-uploads";
import { SettingsPage } from "./settings-page";

afterEach(() => vi.unstubAllGlobals());

describe("Settings → Plugin & mod uploads", () => {
  it("loads the policy from the settings wrapper and saves it back", async () => {
    const calls: Array<{ method: string; body: unknown }> = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init: RequestInit = {}) => {
        const method = init.method ?? "GET";
        const body = init.body ? JSON.parse(String(init.body)) : undefined;
        calls.push({ method, body });
        if (!url.endsWith("/settings/extensions.uploads"))
          return jsonResponse(apiErrorBody("NOT_FOUND"), { status: 404 });
        return jsonResponse({
          key: "extensions.uploads",
          value:
            method === "PUT" ? (body as { value: unknown }).value : { allowed: true, requireMetadata: true },
        });
      }),
    );
    const user = userEvent.setup();
    render(
      <QueryClientProvider client={new QueryClient()}>
        <ExtensionUploadsCard />
      </QueryClientProvider>,
    );
    const allowed = await screen.findByRole("switch", { name: "Allow uploads" });
    expect(allowed.getAttribute("aria-checked")).toBe("true");
    const save = screen.getByRole("button", { name: "Save" }) as HTMLButtonElement;
    expect(save.disabled).toBe(true);
    await user.click(allowed);
    // Metadata requirement only matters while uploads are allowed.
    expect(
      (screen.getByRole("switch", { name: "Require plugin/mod metadata" }) as HTMLButtonElement).disabled,
    ).toBe(true);
    await user.click(save);
    await waitFor(() =>
      expect(calls.find((c) => c.method === "PUT")?.body).toEqual({
        value: { allowed: false, requireMetadata: true },
      }),
    );
  });

  it("is a settings tab for administrators only", () => {
    const page = (permissions: Permission[]) =>
      render(
        <ThemeProvider>
          <QueryClientProvider client={new QueryClient()}>
            <SettingsPage me={makeMe({ permissions })} tab="account" onTabChange={() => {}} />
          </QueryClientProvider>
        </ThemeProvider>,
      );
    const { unmount } = page([]);
    expect(screen.queryByRole("tab", { name: "Plugin uploads" })).toBeNull();
    unmount();
    page(["settings.manage"]);
    expect(screen.getByRole("tab", { name: "Plugin uploads" })).toBeTruthy();
  });
});
