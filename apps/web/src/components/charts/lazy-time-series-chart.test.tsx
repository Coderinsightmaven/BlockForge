import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { ThemeProvider } from "@/lib/theme";
import { TimeSeriesChart } from "./lazy-time-series-chart";

describe("lazily loaded chart", () => {
  it("shows a loading placeholder (no values) until uPlot arrives, then the real chart", async () => {
    render(
      <ThemeProvider>
        <TimeSeriesChart data={null} unit="percent" label="CPU usage, last hour" height={120} />
      </ThemeProvider>,
    );
    const placeholder = screen.getByRole("status", { name: "CPU usage, last hour: loading chart" });
    expect(placeholder.textContent).toBe("Loading chart…");
    expect(placeholder.style.height).toBe("156px");
    // The real component then renders its own state for the data (here: nothing recorded).
    // (First import of uPlot is transformed on demand; allow for a busy test run.)
    expect(await screen.findByText("No data in this time range", {}, { timeout: 10_000 })).toBeTruthy();
    expect(screen.queryByText("Loading chart…")).toBeNull();
  }, 15_000);
});
