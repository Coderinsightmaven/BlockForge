import { useVirtualizer } from "@tanstack/react-virtual";
import { ArrowDownToLine, Clock, Download, Pause, Play, Search, SendHorizontal, Trash2 } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import type { KeyboardEvent } from "react";
import { stripFormatting } from "@blockforge/minecraft";
import { REALTIME_EVENT_PAYLOADS } from "@blockforge/contracts";
import type { Server } from "@blockforge/contracts";
import { serversApi } from "@/lib/api/servers-api";
import { addCommand, getCommandHistory } from "@/lib/console-history";
import { downloadText } from "@/lib/download";
import { describeError } from "@/lib/api/errors";
import { formatTimestamp } from "@/lib/format";
import { useApiMutation } from "@/lib/mutations";
import { useRealtimeClient, useRealtimeStatus, useRealtimeTopic } from "@/lib/realtime/provider";
import { serverActionable, serverCan } from "@/lib/server-permissions";
import { cn } from "@/lib/utils";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Tooltip } from "@/components/ui/tooltip";
import { isEulaPrompt } from "../eula";
import { ConsoleLineView } from "./console-line";
import { ConsoleStore } from "./console-store";
import type { ConsoleLine, ConsoleStream } from "./console-store";

const HISTORY_LINES = 1000;
const ACCEPTS_COMMANDS = new Set(["running", "starting", "degraded", "stopping"]);

const plainCache = new WeakMap<ConsoleLine, string>();
function plainOf(l: ConsoleLine): string {
  let p = plainCache.get(l);
  if (p === undefined) {
    p = stripFormatting(l.line);
    plainCache.set(l, p);
  }
  return p;
}

export function filterLines(
  lines: readonly ConsoleLine[],
  query: string,
  streams: ReadonlySet<ConsoleStream>,
): readonly ConsoleLine[] {
  const q = query.trim().toLowerCase();
  if (!q && streams.size === 3) return lines;
  return lines.filter((l) => streams.has(l.stream) && (!q || plainOf(l).toLowerCase().includes(q)));
}

/** Plain-text export (formatting codes and control characters removed). */
export function consoleToText(lines: readonly ConsoleLine[]): string {
  return lines.map((l) => `${formatTimestamp(l.ts)} [${l.stream}] ${plainOf(l)}`).join("\n") + "\n";
}

function useCommandHistory(serverId: string) {
  const [items, setItems] = useState<readonly string[]>(() => getCommandHistory(serverId));
  const add = (cmd: string) => setItems(addCommand(serverId, cmd));
  return { items, add };
}

export function ConsolePanel({
  server,
  className,
  onEulaPrompt,
}: {
  server: Server;
  className?: string;
  /** Called when Minecraft prints its EULA refusal (history or live). */
  onEulaPrompt?: () => void;
}) {
  const eulaRef = useRef(onEulaPrompt);
  eulaRef.current = onEulaPrompt;
  const client = useRealtimeClient();
  const status = useRealtimeStatus();
  const [historyError, setHistoryError] = useState<unknown>(null);
  const loadHistoryRef = useRef<() => void>(() => {});
  const [store] = useState(() => new ConsoleStore({ onGap: () => loadHistoryRef.current() }));
  useEffect(() => () => store.dispose(), [store]);

  // One history request at a time: a gap or reconnect refetch aborts the one still running.
  const historyCtrl = useRef<AbortController | null>(null);
  const loadHistory = useCallback(() => {
    historyCtrl.current?.abort();
    const ctrl = new AbortController();
    historyCtrl.current = ctrl;
    serversApi
      .consoleHistory(server.id, HISTORY_LINES, ctrl.signal)
      .then((h) => {
        if (ctrl.signal.aborted) return;
        setHistoryError(null);
        store.loadHistory(h);
        if (h.lines.some((l) => isEulaPrompt(l.line))) eulaRef.current?.();
      })
      .catch((err: unknown) => {
        if (!ctrl.signal.aborted && (err as { name?: string }).name !== "AbortError") setHistoryError(err);
      });
  }, [server.id, store]);
  loadHistoryRef.current = loadHistory;

  useEffect(() => {
    loadHistory();
    return () => historyCtrl.current?.abort();
  }, [loadHistory]);
  // Realtime is not durable: re-read history after every reconnect (merged by seq, no duplicates).
  useEffect(() => client?.onReconnect(() => loadHistory()), [client, loadHistory]);

  useRealtimeTopic(`console:${server.id}`, (event) => {
    if (event.type !== "console.lines") return;
    const parsed = REALTIME_EVENT_PAYLOADS["console.lines"].safeParse(event.data);
    if (!parsed.success || parsed.data.serverId !== server.id) return;
    store.push(parsed.data);
    if (parsed.data.lines.some((l) => isEulaPrompt(l.line))) eulaRef.current?.();
  });

  useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot);
  const allLines = store.all();

  // --- view state -------------------------------------------------------------------------
  const [query, setQuery] = useState("");
  const [streams, setStreams] = useState<Set<ConsoleStream>>(() => new Set(["stdout", "stderr", "system"]));
  const [showTs, setShowTs] = useState(() => localStorage.getItem("blockforge.console-ts") === "1");
  const [paused, setPaused] = useState<readonly ConsoleLine[] | null>(null);
  // Counted in appended lines, not buffer length (which stops growing at the ring cap).
  const [pausedAt, setPausedAt] = useState(0);
  const [follow, setFollow] = useState(true);

  const source = paused ?? allLines;
  const lines = useMemo(() => filterLines(source, query, streams), [source, query, streams]);
  const newWhilePaused = paused ? store.appendedCount - pausedAt : 0;

  const scrollRef = useRef<HTMLDivElement>(null);
  const virtualizer = useVirtualizer({
    count: lines.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => 18,
    overscan: 20,
    initialRect: { width: 0, height: 480 },
  });

  useEffect(() => {
    if (follow && lines.length) virtualizer.scrollToIndex(lines.length - 1, { align: "end" });
  }, [follow, lines, virtualizer]);

  const onScroll = () => {
    const el = scrollRef.current;
    if (!el) return;
    const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 24;
    if (atBottom !== follow) setFollow(atBottom);
  };

  const toggleStream = (s: ConsoleStream) =>
    setStreams((prev) => {
      const next = new Set(prev);
      if (next.has(s)) next.delete(s);
      else next.add(s);
      return next.size === 0 ? prev : next;
    });

  // --- command input ----------------------------------------------------------------------
  const history = useCommandHistory(server.id);
  const [command, setCommand] = useState("");
  const [historyIdx, setHistoryIdx] = useState<number | null>(null);
  const canSend = serverActionable(server, "servers.console.send");
  const online = ACCEPTS_COMMANDS.has(server.state);
  const send = useApiMutation({
    mutationFn: (cmd: string) => serversApi.sendCommand(server.id, cmd),
    errorTitle: "Command not sent",
  });

  const submit = () => {
    const cmd = command.trim();
    if (!cmd || /[\r\n\0]/.test(cmd) || cmd.length > 1024) return;
    history.add(cmd);
    setCommand("");
    setHistoryIdx(null);
    setFollow(true);
    send.mutate(cmd);
  };

  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter") {
      e.preventDefault();
      submit();
    } else if (e.key === "ArrowUp" && history.items.length) {
      e.preventDefault();
      const idx = historyIdx === null ? history.items.length - 1 : Math.max(0, historyIdx - 1);
      setHistoryIdx(idx);
      setCommand(history.items[idx] ?? "");
    } else if (e.key === "ArrowDown" && historyIdx !== null) {
      e.preventDefault();
      const idx = historyIdx + 1;
      if (idx >= history.items.length) {
        setHistoryIdx(null);
        setCommand("");
      } else {
        setHistoryIdx(idx);
        setCommand(history.items[idx] ?? "");
      }
    }
  };

  const live = status.state === "open";
  const items = virtualizer.getVirtualItems();

  return (
    <div className={cn("flex min-w-0 flex-col overflow-hidden rounded-lg border bg-[#0d1117]", className)}>
      <div className="flex flex-wrap items-center gap-1.5 border-b border-white/10 bg-[#161b22] px-2 py-1.5 text-[#c9d1d9]">
        <div className="relative min-w-0 flex-1 sm:max-w-64">
          <Search className="pointer-events-none absolute top-1.5 left-2 size-4 text-[#8b949e]" aria-hidden />
          <Input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Filter output…"
            aria-label="Filter console output"
            className="h-7 border-white/15 bg-[#0d1117] pl-7 text-xs text-[#c9d1d9]"
          />
        </div>
        <div className="flex items-center gap-0.5" role="group" aria-label="Streams">
          {(["stdout", "stderr", "system"] as const).map((s) => (
            <button
              key={s}
              type="button"
              aria-pressed={streams.has(s)}
              onClick={() => toggleStream(s)}
              className={cn(
                "h-7 rounded px-1.5 text-[11px] text-[#8b949e] hover:bg-white/10",
                streams.has(s) && "bg-white/10 text-[#e6edf3]",
              )}
            >
              {s}
            </button>
          ))}
        </div>
        <div className="ml-auto flex items-center gap-0.5">
          <span aria-live="polite" className="mr-1">
            {live ? (
              <Badge tone="success">Live</Badge>
            ) : (
              <Badge tone="warning">
                {status.state === "reconnecting" ? "Reconnecting…" : "Connecting…"}
              </Badge>
            )}
          </span>
          <Tooltip content={showTs ? "Hide timestamps" : "Show timestamps"}>
            <Button
              size="icon-sm"
              variant="ghost"
              aria-pressed={showTs}
              aria-label="Timestamps"
              className={cn("text-[#8b949e] hover:bg-white/10 hover:text-white", showTs && "text-white")}
              onClick={() => {
                setShowTs((v) => !v);
                localStorage.setItem("blockforge.console-ts", showTs ? "0" : "1");
              }}
            >
              <Clock aria-hidden />
            </Button>
          </Tooltip>
          <Tooltip content={paused ? "Resume" : "Pause output"}>
            <Button
              size="icon-sm"
              variant="ghost"
              aria-pressed={!!paused}
              aria-label={paused ? "Resume output" : "Pause output"}
              className="text-[#8b949e] hover:bg-white/10 hover:text-white"
              onClick={() => {
                if (!paused) setPausedAt(store.appendedCount);
                setPaused((p) => (p ? null : allLines));
              }}
            >
              {paused ? <Play aria-hidden /> : <Pause aria-hidden />}
            </Button>
          </Tooltip>
          <Tooltip content="Download output">
            <Button
              size="icon-sm"
              variant="ghost"
              aria-label="Download console output"
              className="text-[#8b949e] hover:bg-white/10 hover:text-white"
              onClick={() =>
                downloadText(`${server.slug || server.shortId}-console.log`, consoleToText(allLines))
              }
            >
              <Download aria-hidden />
            </Button>
          </Tooltip>
          <Tooltip content="Clear view (the server keeps its log)">
            <Button
              size="icon-sm"
              variant="ghost"
              aria-label="Clear console view"
              className="text-[#8b949e] hover:bg-white/10 hover:text-white"
              onClick={() => store.clear()}
            >
              <Trash2 aria-hidden />
            </Button>
          </Tooltip>
        </div>
      </div>

      {historyError && allLines.length > 0 ? (
        <div
          role="alert"
          className="flex items-center gap-2 border-b border-white/10 bg-[#2a1515] px-3 py-1 text-xs text-[#ff9b9b]"
        >
          <span className="min-w-0 flex-1">
            Could not reload console history: {describeError(historyError).title}
          </span>
          <button type="button" className="underline hover:text-white" onClick={() => loadHistory()}>
            Retry
          </button>
        </div>
      ) : null}
      <div className="relative min-h-0 flex-1">
        <div
          ref={scrollRef}
          onScroll={onScroll}
          role="log"
          aria-label={`Console of ${server.name}`}
          aria-live="off"
          tabIndex={0}
          className="h-full overflow-auto px-3 py-2 font-mono text-[12px] leading-[18px] break-all whitespace-pre-wrap focus-visible:outline-none"
        >
          {historyError && allLines.length === 0 ? (
            <p role="alert" className="text-[#ff8080]">
              Could not load console history: {describeError(historyError).title}{" "}
              <button type="button" className="underline hover:text-white" onClick={() => loadHistory()}>
                Retry
              </button>
            </p>
          ) : lines.length === 0 ? (
            <p className="text-[#6b7280]">
              {allLines.length === 0 ? "No output yet." : "No lines match the filter."}
            </p>
          ) : (
            <div style={{ height: virtualizer.getTotalSize(), position: "relative" }}>
              {items.map((vi) => (
                <div
                  key={vi.key}
                  data-index={vi.index}
                  ref={virtualizer.measureElement}
                  style={{
                    position: "absolute",
                    top: 0,
                    left: 0,
                    width: "100%",
                    transform: `translateY(${vi.start}px)`,
                  }}
                >
                  <ConsoleLineView line={lines[vi.index]!} showTimestamp={showTs} />
                </div>
              ))}
            </div>
          )}
        </div>
        {paused || !follow ? (
          <div className="absolute right-3 bottom-2 flex gap-1.5">
            {paused ? (
              <Button size="sm" onClick={() => setPaused(null)}>
                <Play aria-hidden />
                Resume{newWhilePaused > 0 ? ` (${newWhilePaused} new)` : ""}
              </Button>
            ) : (
              <Button size="sm" variant="secondary" onClick={() => setFollow(true)}>
                <ArrowDownToLine aria-hidden />
                Follow
              </Button>
            )}
          </div>
        ) : null}
      </div>

      {serverCan(server, "servers.console.send") ? (
        <form
          className="flex items-center gap-1.5 border-t border-white/10 bg-[#161b22] p-1.5"
          onSubmit={(e) => {
            e.preventDefault();
            submit();
          }}
        >
          <span className="pl-1 font-mono text-xs text-[#8b949e] select-none" aria-hidden>
            &gt;
          </span>
          <input
            value={command}
            onChange={(e) => {
              setCommand(e.target.value);
              setHistoryIdx(null);
            }}
            onKeyDown={onKeyDown}
            disabled={!canSend || !online}
            maxLength={1024}
            autoComplete="off"
            autoCapitalize="off"
            spellCheck={false}
            aria-label="Console command"
            placeholder={
              !canSend
                ? "Server is suspended"
                : online
                  ? "Type a command… (↑/↓ for history)"
                  : "Server is offline"
            }
            className="h-8 min-w-0 flex-1 bg-transparent font-mono text-[13px] text-[#e6edf3] outline-none placeholder:text-[#6b7280] disabled:opacity-60"
          />
          <Button
            type="submit"
            size="icon-sm"
            variant="ghost"
            aria-label="Send command"
            disabled={!canSend || !online || !command.trim()}
            loading={send.isPending}
            className="text-[#c9d1d9] hover:bg-white/10"
          >
            <SendHorizontal aria-hidden />
          </Button>
        </form>
      ) : null}
    </div>
  );
}
