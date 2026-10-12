import { render } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { SERVER_ID } from "@/test/fixtures";
import { consoleToText, filterLines } from "./console-panel";
import { ConsoleLineView, ConsoleText, colorCss } from "./console-line";
import { ConsoleStore } from "./console-store";
import type { ConsoleLine } from "./console-store";

describe("console rendering is text-only", () => {
  it("renders HTML in log lines as literal text", () => {
    const evil = `<img src=x onerror="alert(1)"><script>alert(2)</script>&lt;b&gt;`;
    const { container } = render(<ConsoleText text={evil} />);
    expect(container.querySelector("img")).toBeNull();
    expect(container.querySelector("script")).toBeNull();
    expect(container.textContent).toBe(evil);
    expect(container.innerHTML).toContain("&lt;img");
  });

  it("colours § and ANSI codes with inline styles and strips control sequences", () => {
    const { container } = render(
      <ConsoleText text={"§cRed §a§lGreen-bold\u001b[0m plain \u001b[31mansi\u001b]0;title\u0007\u0007"} />,
    );
    const spans = [...container.querySelectorAll("span")];
    expect(container.textContent).toBe("Red Green-bold plain ansi");
    expect(spans.find((s) => s.textContent === "Red ")?.style.color).toBe("rgb(255, 85, 85)");
    const green = spans.find((s) => s.textContent === "Green-bold")!;
    expect(green.style.fontWeight).toBe("600");
    expect(spans.find((s) => s.textContent === "ansi")?.style.color).toBe("rgb(224, 75, 75)");
    // No style attribute can carry anything but the computed colour/weight.
    for (const s of spans) expect(s.getAttribute("style") ?? "").not.toMatch(/url\(|expression|javascript/i);
  });

  it("only accepts validated hex colours", () => {
    expect(colorCss({ kind: "rgb", hex: "#12ab9f" })).toBe("#12ab9f");
    expect(colorCss({ kind: "rgb", hex: "red;background:url(x)" })).toBeUndefined();
    expect(colorCss({ kind: "ansi", index: 196 })).toMatch(/^rgb\(/);
  });

  it("marks system (install/notice) lines", () => {
    const line: ConsoleLine = {
      seq: 1,
      ts: Date.UTC(2026, 9, 12, 8, 0, 5),
      stream: "system",
      line: "Installing Paper 1.21.4…",
    };
    const { container } = render(<ConsoleLineView line={line} showTimestamp />);
    expect(container.textContent).toBe("08:00:05[BlockForge]Installing Paper 1.21.4…");
  });
});

function syncStore(opts: ConstructorParameters<typeof ConsoleStore>[0] = {}) {
  const store = new ConsoleStore({ schedule: (cb) => (cb(), 1), cancel: () => {}, ...opts });
  return store;
}
const ev = (seqs: number[], extra: Partial<{ dropped: number }> = {}) => ({
  serverId: SERVER_ID,
  lines: seqs.map((seq) => ({ seq, ts: 1000 + seq, stream: "stdout" as const, line: `line ${seq}` })),
  ...extra,
});

describe("ConsoleStore", () => {
  it("merges history and live events by seq without duplicates", () => {
    const store = syncStore();
    store.push(ev([5, 6]));
    store.loadHistory(ev([1, 2, 3, 4, 5]));
    store.push(ev([6, 7]));
    expect(store.all().map((l) => l.seq)).toEqual([1, 2, 3, 4, 5, 6, 7]);
  });

  it("detects gaps, inserts a notice and asks for history", () => {
    const onGap = vi.fn();
    const store = syncStore({ onGap });
    store.push(ev([1, 2]));
    store.push(ev([10]));
    expect(onGap).toHaveBeenCalledOnce();
    const notice = store.all().find((l) => l.local);
    expect(notice?.line).toMatch(/7 line\(s\) missed/);
    // The history refetch fills the gap; the notice stays in order.
    store.loadHistory(ev([3, 4, 5, 6, 7, 8, 9, 10]));
    expect(
      store
        .all()
        .filter((l) => !l.local)
        .map((l) => l.seq),
    ).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
  });

  it("reports server-side drops and caps memory", () => {
    const store = syncStore({ max: 5 });
    store.push(ev([1, 2, 3, 4, 5, 6, 7], { dropped: 12 }));
    expect(store.all()).toHaveLength(5);
    expect(store.all().at(-1)?.line).toMatch(/12 line\(s\) were dropped/);
  });

  it("notifies subscribers once per frame for a burst", () => {
    const frames: Array<() => void> = [];
    const store = new ConsoleStore({ schedule: (cb) => frames.push(cb), cancel: () => {} });
    const listener = vi.fn();
    store.subscribe(listener);
    for (let i = 1; i <= 100; i++) store.push(ev([i]));
    expect(frames).toHaveLength(1);
    frames[0]!();
    expect(listener).toHaveBeenCalledOnce();
    expect(store.getSnapshot()).toBe(1);
  });
});

describe("console filtering and export", () => {
  const lines: ConsoleLine[] = [
    { seq: 1, ts: 0, stream: "stdout", line: "§a[12:00:00 INFO]: Done (3.2s)!" },
    { seq: 2, ts: 0, stream: "stderr", line: "java.lang.NullPointerException" },
    { seq: 3, ts: 0, stream: "system", line: "Server started" },
  ];
  it("filters on plain text (formatting ignored) and stream", () => {
    expect(filterLines(lines, "done", new Set(["stdout", "stderr", "system"])).map((l) => l.seq)).toEqual([
      1,
    ]);
    expect(filterLines(lines, "a[12", new Set(["stdout", "stderr", "system"]))).toEqual([]);
    expect(filterLines(lines, "", new Set(["stderr"])).map((l) => l.seq)).toEqual([2]);
  });
  it("exports plain text", () => {
    const text = consoleToText(lines);
    expect(text).toContain("[stdout] [12:00:00 INFO]: Done (3.2s)!");
    expect(text).not.toContain("§");
  });
});
