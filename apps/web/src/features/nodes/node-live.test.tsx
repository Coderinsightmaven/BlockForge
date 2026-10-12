import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import type { NodeMetricSample } from "@blockforge/contracts";
import { TooltipProvider } from "@/components/ui/tooltip";
import { MemoryTile } from "./node-live";

const GiB = 1024 ** 3;

function sample(memory: Partial<NodeMetricSample["memory"]>): NodeMetricSample {
  return {
    ts: 1,
    cpu: { usagePct: 1 },
    memory: {
      totalBytes: 16 * GiB,
      usedBytes: 4 * GiB,
      availableBytes: 10 * GiB,
      swapTotalBytes: 0,
      ...memory,
    },
    filesystems: [],
    diskIo: [],
    network: [],
  };
}

const renderTile = (s: NodeMetricSample) =>
  render(
    <TooltipProvider>
      <MemoryTile sample={s} />
    </TooltipProvider>,
  );

describe("MemoryTile", () => {
  it("derives free memory only when cache and buffers are both reported", () => {
    const { container } = renderTile(sample({ cachedBytes: 6 * GiB, buffersBytes: 1 * GiB }));
    expect(container.querySelector('[title^="Free:"]')?.getAttribute("title")).toBe("Free: 5.00 GiB");
    expect(screen.queryByText(/free memory is not derived/)).toBeNull();
  });

  it("draws no invented free segment when cache/buffers are missing", () => {
    const { container } = renderTile(sample({ cachedBytes: 6 * GiB }));
    expect(container.querySelector('[title^="Free"]')).toBeNull();
    expect(container.querySelector('[title^="Used:"]')).not.toBeNull();
    expect(container.querySelector('[title^="Cached:"]')).not.toBeNull();
    expect(screen.getByText("Not reported")).toBeTruthy(); // buffers
    expect(screen.getByText(/free memory is not derived/)).toBeTruthy();
  });

  it("marks both as not reported when neither is present", () => {
    const { container } = renderTile(sample({}));
    expect(container.querySelector('[title^="Free"]')).toBeNull();
    expect(screen.getAllByText("Not reported")).toHaveLength(2);
  });
});
