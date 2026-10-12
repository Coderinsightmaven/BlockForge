import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Component } from "react";
import type { ReactNode } from "react";
import { describe, expect, it, vi } from "vitest";
import { retryableLazy } from "@/lib/lazy";
import { LazySection } from "./chunk-boundary";
import { LazyDialog } from "./lazy-dialog";

/** A dynamic import that fails `failures` times (like a dropped connection), then resolves. */
function flakyImport(failures: number, text = "Tab content") {
  let calls = 0;
  const load = vi.fn(async () => {
    calls++;
    if (calls <= failures) throw new TypeError("Failed to fetch dynamically imported module");
    return { default: () => <p>{text}</p> };
  });
  return load;
}

class Outer extends Component<{ children: ReactNode }, { error: string | null }> {
  override state = { error: null as string | null };
  static getDerivedStateFromError(e: unknown) {
    return { error: e instanceof Error ? e.message : String(e) };
  }
  override render() {
    return this.state.error ? <p>outer caught: {this.state.error}</p> : this.props.children;
  }
}

describe("lazy chunks that fail to download", () => {
  it("a tab shows an error with Retry, and Retry downloads it again", async () => {
    const load = flakyImport(1);
    const Tab = retryableLazy(load);
    const user = userEvent.setup();
    render(
      <LazySection what="this tab" loading={<p>Loading tab…</p>}>
        <Tab />
      </LazySection>,
    );
    expect(screen.getByText("Loading tab…")).toBeTruthy();
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("Could not load this tab");
    expect(within(alert).getByRole("button", { name: "Reload page" })).toBeTruthy();
    expect(screen.queryByText("Tab content")).toBeNull();
    await user.click(within(alert).getByRole("button", { name: "Retry" }));
    expect(await screen.findByText("Tab content")).toBeTruthy();
    expect(load).toHaveBeenCalledTimes(2);
  });

  it("keeps offering Retry while the download keeps failing", async () => {
    const load = flakyImport(2);
    const Tab = retryableLazy(load);
    const user = userEvent.setup();
    render(
      <LazySection what="this tab" loading={<p>Loading tab…</p>}>
        <Tab />
      </LazySection>,
    );
    await user.click(await screen.findByRole("button", { name: "Retry" }));
    await user.click(await screen.findByRole("button", { name: "Retry" }));
    expect(await screen.findByText("Tab content")).toBeTruthy();
    expect(load).toHaveBeenCalledTimes(3);
  });

  it("a failed preload is not sticky: opening downloads again", async () => {
    const load = flakyImport(1);
    const Tab = retryableLazy(load);
    await Tab.preload(); // fails quietly (hover prefetch)
    render(
      <LazySection what="this tab" loading={<p>Loading tab…</p>}>
        <Tab />
      </LazySection>,
    );
    expect(await screen.findByText("Tab content")).toBeTruthy();
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("a preloaded chunk renders without a loading state", async () => {
    const Tab = retryableLazy(flakyImport(0));
    await Tab.preload();
    render(
      <LazySection what="this tab" loading={<p>Loading tab…</p>}>
        <Tab />
      </LazySection>,
    );
    expect(screen.getByText("Tab content")).toBeTruthy();
    expect(screen.queryByText("Loading tab…")).toBeNull();
  });

  it("errors other than a failed download are not swallowed", async () => {
    const Broken = retryableLazy(async () => ({
      default: () => {
        throw new Error("render bug");
      },
    }));
    vi.spyOn(console, "error").mockImplementation(() => {});
    render(
      <Outer>
        <LazySection what="this tab" loading={<p>Loading tab…</p>}>
          <Broken />
        </LazySection>
      </Outer>,
    );
    expect(await screen.findByText("outer caught: render bug")).toBeTruthy();
    expect(screen.queryByText(/Could not load/)).toBeNull();
    vi.mocked(console.error).mockRestore();
  });

  it("a dialog shows a loading dialog, then an error dialog with Retry and Close", async () => {
    const load = flakyImport(1, "Dialog body");
    const Body = retryableLazy(load);
    const onClose = vi.fn();
    const user = userEvent.setup();
    render(
      <LazyDialog title="Ban a player" onClose={onClose}>
        <Body />
      </LazyDialog>,
    );
    const loading = screen.getByRole("dialog", { name: "Ban a player" });
    expect(within(loading).getByText("Loading…")).toBeTruthy();
    const failed = await screen.findByRole("alert");
    expect(failed.textContent).toContain("Could not load this dialog");
    const dialog = screen.getByRole("dialog", { name: "Ban a player" });
    await user.click(within(dialog).getByRole("button", { name: "Retry" }));
    expect(await screen.findByText("Dialog body")).toBeTruthy();
    expect(load).toHaveBeenCalledTimes(2);
  });

  it("Close on the error dialog closes it without retrying", async () => {
    const load = flakyImport(5, "Dialog body");
    const Body = retryableLazy(load);
    const onClose = vi.fn();
    const user = userEvent.setup();
    render(
      <LazyDialog title="Upload a plugin or mod" onClose={onClose}>
        <Body />
      </LazyDialog>,
    );
    await screen.findByRole("alert");
    await user.click(screen.getByText("Close", { selector: "button" }));
    await waitFor(() => expect(onClose).toHaveBeenCalled());
    await act(async () => {});
    expect(load).toHaveBeenCalledTimes(1);
  });
});
