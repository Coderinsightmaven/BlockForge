import { useVirtualizer } from "@tanstack/react-virtual";
import { ArrowDownToLine } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import type { JobLogLine } from "@blockforge/contracts";
import { formatTime } from "@/lib/format";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";

/** Within this many px of the bottom counts as "at the bottom" (sub-pixel scroll positions). */
const BOTTOM_SLACK_PX = 24;

export function isAtBottom(el: Pick<HTMLElement, "scrollHeight" | "scrollTop" | "clientHeight">): boolean {
  return el.scrollHeight - el.scrollTop - el.clientHeight < BOTTOM_SLACK_PX;
}

/**
 * Install/reinstall job output. Windowed (only visible rows are in the DOM — a modpack install
 * can log thousands of lines) and it follows new output only while the reader is at the bottom;
 * scrolling up to read stops following until "Follow" or scrolling back down.
 */
export function JobLog({ logs }: { logs: readonly JobLogLine[] }) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const [follow, setFollow] = useState(true);
  const virtualizer = useVirtualizer({
    count: logs.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => 16,
    overscan: 12,
    initialRect: { width: 0, height: 256 },
  });

  useEffect(() => {
    if (follow && logs.length) virtualizer.scrollToIndex(logs.length - 1, { align: "end" });
  }, [follow, logs, virtualizer]);

  const onScroll = () => {
    const el = scrollRef.current;
    if (!el) return;
    const bottom = isAtBottom(el);
    if (bottom !== follow) setFollow(bottom);
  };

  return (
    <div className="relative">
      <div
        ref={scrollRef}
        onScroll={onScroll}
        role="log"
        aria-label="Job log"
        aria-live="off"
        tabIndex={0}
        className="max-h-64 overflow-auto rounded-md bg-[#0d1117] p-2 font-mono text-[11px] leading-4 break-all whitespace-pre-wrap text-[#c9d1d9] focus-visible:outline-2 focus-visible:outline-ring"
      >
        {logs.length === 0 ? (
          <span className="text-[#6b7280]">Waiting for output…</span>
        ) : (
          <div style={{ height: virtualizer.getTotalSize(), position: "relative" }}>
            {virtualizer.getVirtualItems().map((vi) => {
              const l = logs[vi.index]!;
              return (
                <div
                  key={l.id}
                  data-index={vi.index}
                  ref={virtualizer.measureElement}
                  className={cn(
                    l.level === "error" && "text-[#ff8080]",
                    l.level === "warn" && "text-[#f0a92a]",
                  )}
                  style={{
                    position: "absolute",
                    top: 0,
                    left: 0,
                    width: "100%",
                    transform: `translateY(${vi.start}px)`,
                  }}
                >
                  <span className="mr-2 text-[#6b7280]">{formatTime(l.ts)}</span>
                  {l.message}
                </div>
              );
            })}
          </div>
        )}
      </div>
      {!follow && logs.length ? (
        <Button
          size="sm"
          variant="secondary"
          className="absolute right-3 bottom-2"
          onClick={() => setFollow(true)}
        >
          <ArrowDownToLine aria-hidden />
          Follow
        </Button>
      ) : null}
    </div>
  );
}
