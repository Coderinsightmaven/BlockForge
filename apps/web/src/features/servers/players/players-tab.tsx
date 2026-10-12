import { useQuery, useQueryClient } from "@tanstack/react-query";
import type { InfiniteData } from "@tanstack/react-query";
import { Ban, RefreshCw, ShieldCheck, UserCheck, UserX } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { BanIpAddress, PlayerName, REALTIME_EVENT_PAYLOADS } from "@blockforge/contracts";
import type {
  Page,
  PlayerActionKind,
  PlayerActionRequest,
  PlayerSession,
  PlayersOverview,
  Server,
} from "@blockforge/contracts";
import { playersApi } from "@/lib/api/players-api";
import { useApiMutation } from "@/lib/mutations";
import { qk } from "@/lib/query-keys";
import { useRealtimeClient, useRealtimeTopic } from "@/lib/realtime/provider";
import { preloadWhenIdle, retryableLazy } from "@/lib/lazy";
import { parseTimeRange } from "@/lib/time-range";
import { ChartLoading } from "@/components/charts/lazy-time-series-chart";
import { LazySection } from "@/components/common/chunk-boundary";
import { LazyDialog } from "@/components/common/lazy-dialog";
import { ErrorState, TableSkeleton } from "@/components/common/states";
import { Timestamp } from "@/components/common/timestamp";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Callout } from "@/components/ui/callout";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Switch } from "@/components/ui/switch";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Tooltip } from "@/components/ui/tooltip";
import {
  actionGate,
  applyJoined,
  applyLeft,
  banExpiry,
  describePlayerActionError,
  sessionsJoined,
  sessionsLeft,
  ACTION_TITLE,
} from "./player-model";
import type { DialogAction } from "./player-model";

type Feedback = { tone: "success" | "warning" | "danger"; title: string; detail: string | null };

/** A button for one player action, shown only when the overview offers it; disabled with the reason. */
function ActionButton({
  gate,
  label,
  onClick,
  icon: Icon,
  variant = "ghost",
}: {
  gate: ReturnType<typeof actionGate>;
  label: string;
  onClick: () => void;
  icon?: typeof Ban;
  variant?: "ghost" | "outline";
}) {
  if (!gate.offered) return null;
  return (
    <Tooltip content={gate.reason}>
      <span>
        <Button size="sm" variant={variant} disabled={!gate.allowed} onClick={onClick}>
          {Icon ? <Icon aria-hidden /> : null}
          {label}
        </Button>
      </span>
    </Tooltip>
  );
}

function OnlineCard({
  server,
  overview,
  gate,
  open,
  run,
}: {
  server: Server;
  overview: PlayersOverview;
  gate: (a: PlayerActionKind) => ReturnType<typeof actionGate>;
  open: (a: DialogAction, name: string | null, uuid?: string | null) => void;
  run: (body: PlayerActionRequest) => void;
}) {
  const o = overview.online;
  const ops = new Set(overview.ops.map((x) => x.name.toLowerCase()));
  const whitelisted = new Set(overview.whitelist.entries.map((x) => x.name.toLowerCase()));
  return (
    <Card>
      <CardHeader>
        <div>
          <CardTitle>Online</CardTitle>
          <CardDescription>
            {o.source === "list"
              ? "From the server's player list."
              : o.source === "slp"
                ? "From the last status ping — names may be incomplete."
                : "No player data yet."}
            {o.at ? (
              <>
                {" "}
                Updated <Timestamp ts={o.at} />.
              </>
            ) : null}
          </CardDescription>
        </div>
        <span className="text-lg font-semibold tabular" aria-label="Players online">
          {o.count === null ? "—" : `${o.count} / ${o.max ?? "—"}`}
        </span>
      </CardHeader>
      <CardContent className="flex flex-col gap-2">
        {o.count === null ? (
          <p className="text-sm text-muted-foreground">
            Unknown — the server is not running or has not reported its players yet.
          </p>
        ) : o.players.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            {o.count === 0 ? "Nobody is online." : "The status ping reported players but no names."}
          </p>
        ) : (
          <ul className="flex flex-col divide-y">
            {o.players.map((p) => (
              <li key={p.name} className="flex flex-wrap items-center gap-2 py-1.5">
                <span className="font-medium">{p.name}</span>
                {p.uuid ? (
                  <code className="font-mono text-[11px] text-muted-foreground">{p.uuid}</code>
                ) : null}
                {ops.has(p.name.toLowerCase()) ? <Badge tone="info">Operator</Badge> : null}
                <span className="ml-auto flex flex-wrap gap-1">
                  <ActionButton gate={gate("kick")} label="Kick" onClick={() => open("kick", p.name)} />
                  <ActionButton
                    gate={gate("ban")}
                    label="Ban"
                    icon={Ban}
                    onClick={() => open("ban", p.name, p.uuid)}
                  />
                  {ops.has(p.name.toLowerCase()) ? (
                    <ActionButton
                      gate={gate("deop")}
                      label="Deop"
                      onClick={() => run({ action: "deop", name: p.name })}
                    />
                  ) : (
                    <ActionButton gate={gate("op")} label="Op" onClick={() => open("op", p.name, p.uuid)} />
                  )}
                  {overview.whitelist.enabled && !whitelisted.has(p.name.toLowerCase()) ? (
                    <ActionButton
                      gate={gate("whitelist-add")}
                      label="Whitelist"
                      onClick={() => open("whitelist-add", p.name, p.uuid)}
                    />
                  ) : null}
                </span>
              </li>
            ))}
          </ul>
        )}
        {o.skipped > 0 ? (
          <p className="text-xs text-muted-foreground">
            {o.skipped} entr{o.skipped === 1 ? "y was" : "ies were"} not a valid player name and{" "}
            {o.skipped === 1 ? "is" : "are"} not shown.
          </p>
        ) : null}
        <p className="text-xs text-muted-foreground">
          Online mode:{" "}
          {overview.onlineMode === null ? "unknown" : overview.onlineMode ? "on (Mojang accounts)" : "off"}
          {server.state !== "running" ? ` · server is ${server.state.replace("_", " ")}` : ""}
        </p>
      </CardContent>
    </Card>
  );
}

const validName = (n: string) => PlayerName.safeParse(n).success;

function ListsCard({
  overview,
  gate,
  open,
  run,
  pending,
}: {
  overview: PlayersOverview;
  gate: (a: PlayerActionKind) => ReturnType<typeof actionGate>;
  open: (a: DialogAction, name: string | null) => void;
  run: (body: PlayerActionRequest) => void;
  pending: boolean;
}) {
  const w = overview.whitelist;
  const setGate = gate("whitelist-set");
  return (
    <Card>
      <CardHeader>
        <div>
          <CardTitle>Whitelist, operators &amp; bans</CardTitle>
          <CardDescription>Read from the server's list files.</CardDescription>
        </div>
      </CardHeader>
      <CardContent className="flex flex-col gap-5">
        <section aria-labelledby="wl-title" className="flex flex-col gap-2">
          <div className="flex flex-wrap items-center gap-2">
            <h3 id="wl-title" className="text-sm font-semibold">
              Whitelist
            </h3>
            <Badge tone={w.enabled ? "success" : "neutral"}>
              {w.enabled === null ? "Unknown" : w.enabled ? "On" : "Off"}
            </Badge>
            {w.enforced ? <Badge variant="outline">Enforced</Badge> : null}
            <span className="ml-auto flex flex-wrap items-center gap-1">
              {setGate.offered && w.enabled !== null ? (
                <Tooltip content={setGate.reason}>
                  <span className="inline-flex items-center gap-1.5 text-xs">
                    <Switch
                      checked={w.enabled}
                      aria-label={w.enabled ? "Turn the whitelist off" : "Turn the whitelist on"}
                      disabled={!setGate.allowed || pending}
                      onCheckedChange={(v) => run({ action: "whitelist-set", enabled: v })}
                    />
                  </span>
                </Tooltip>
              ) : null}
              <ActionButton
                gate={gate("whitelist-reload")}
                label="Reload"
                icon={RefreshCw}
                onClick={() => run({ action: "whitelist-reload" })}
              />
              <ActionButton
                gate={gate("whitelist-add")}
                label="Add"
                icon={UserCheck}
                variant="outline"
                onClick={() => open("whitelist-add", null)}
              />
            </span>
          </div>
          {w.enforced ? (
            <p className="text-xs text-muted-foreground">
              Players not on the list are kicked when it is (re)loaded.
            </p>
          ) : null}
          {w.entries.length === 0 ? (
            <p className="text-xs text-muted-foreground">No entries.</p>
          ) : (
            <ul className="flex flex-col divide-y text-sm">
              {w.entries.map((e) => (
                <li key={e.uuid} className="flex items-center gap-2 py-1">
                  <span className="break-all">{e.name}</span>
                  <code className="font-mono text-[11px] text-muted-foreground">{e.uuid}</code>
                  <span className="ml-auto">
                    {validName(e.name) ? (
                      <ActionButton
                        gate={gate("whitelist-remove")}
                        label="Remove"
                        onClick={() => run({ action: "whitelist-remove", name: e.name })}
                      />
                    ) : (
                      <span className="text-xs text-muted-foreground">not a valid name</span>
                    )}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </section>

        <section aria-labelledby="ops-title" className="flex flex-col gap-2">
          <div className="flex items-center gap-2">
            <h3 id="ops-title" className="text-sm font-semibold">
              Operators
            </h3>
            <span className="ml-auto">
              <ActionButton
                gate={gate("op")}
                label="Add operator"
                icon={ShieldCheck}
                variant="outline"
                onClick={() => open("op", null)}
              />
            </span>
          </div>
          {overview.ops.length === 0 ? (
            <p className="text-xs text-muted-foreground">No operators.</p>
          ) : (
            <ul className="flex flex-col divide-y text-sm">
              {overview.ops.map((op) => (
                <li key={op.uuid} className="flex items-center gap-2 py-1">
                  <span className="break-all">{op.name}</span>
                  <Badge variant="outline">Level {op.level}</Badge>
                  {op.bypassesPlayerLimit ? <Badge variant="outline">Bypasses limit</Badge> : null}
                  <span className="ml-auto">
                    {validName(op.name) ? (
                      <ActionButton
                        gate={gate("deop")}
                        label="Deop"
                        onClick={() => run({ action: "deop", name: op.name })}
                      />
                    ) : null}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </section>

        <section aria-labelledby="bans-title" className="flex flex-col gap-2">
          <div className="flex flex-wrap items-center gap-2">
            <h3 id="bans-title" className="text-sm font-semibold">
              Bans
            </h3>
            <span className="ml-auto flex gap-1">
              <ActionButton
                gate={gate("ban")}
                label="Ban player"
                icon={UserX}
                variant="outline"
                onClick={() => open("ban", null)}
              />
              <ActionButton
                gate={gate("ban-ip")}
                label="Ban IP"
                icon={Ban}
                variant="outline"
                onClick={() => open("ban-ip", null)}
              />
            </span>
          </div>
          {overview.bannedPlayers.length === 0 && overview.bannedIps.length === 0 ? (
            <p className="text-xs text-muted-foreground">Nobody is banned.</p>
          ) : (
            <div className="overflow-x-auto">
              <Table>
                <TableHeader>
                  <TableRow className="hover:bg-transparent">
                    <TableHead>Player / IP</TableHead>
                    <TableHead>Reason</TableHead>
                    <TableHead>Expires</TableHead>
                    <TableHead>By</TableHead>
                    <TableHead className="text-right">
                      <span className="sr-only">Actions</span>
                    </TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {[
                    ...overview.bannedPlayers.map((b) => ({
                      ...b,
                      key: b.uuid,
                      label: b.name,
                      ip: null as string | null,
                    })),
                    ...overview.bannedIps.map((b) => ({
                      ...b,
                      key: `ip:${b.ip}`,
                      label: b.ip,
                      ip: b.ip as string | null,
                    })),
                  ].map((b) => (
                    <TableRow key={b.key}>
                      <TableCell className="text-sm">
                        <span className={b.ip ? "font-mono break-all" : "break-all"}>{b.label}</span>{" "}
                        {b.active ? (
                          <Badge tone="danger">Active</Badge>
                        ) : (
                          <Badge tone="neutral">Expired</Badge>
                        )}
                      </TableCell>
                      <TableCell className="max-w-56 text-xs break-words">{b.reason ?? "—"}</TableCell>
                      <TableCell className="text-xs whitespace-nowrap">{banExpiry(b.expiresAt)}</TableCell>
                      <TableCell className="max-w-40 text-xs break-words text-muted-foreground">
                        {b.source}
                      </TableCell>
                      <TableCell className="text-right">
                        {b.ip ? (
                          BanIpAddress.safeParse(b.ip).success ? (
                            <ActionButton
                              gate={gate("pardon-ip")}
                              label="Pardon"
                              onClick={() => run({ action: "pardon-ip", ip: b.ip! })}
                            />
                          ) : null
                        ) : validName(b.label) ? (
                          <ActionButton
                            gate={gate("pardon")}
                            label="Pardon"
                            onClick={() => run({ action: "pardon", name: b.label })}
                          />
                        ) : null}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          )}
        </section>
      </CardContent>
    </Card>
  );
}

const DAY = parseTimeRange("24h");

// Below the fold or behind a click: the chart, the sessions table and the action dialog are their
// own chunks (the dialog is preloaded once the tab is idle).
const MetricChart = retryableLazy(() =>
  import("@/components/charts/metric-chart").then((m) => ({ default: m.MetricChart })),
);
const SessionsCard = retryableLazy(() => import("./sessions-card"));
const ActionDialog = retryableLazy(() => import("./action-dialog"));

function ChartCardLoading() {
  return (
    <Card aria-busy>
      <CardHeader>
        <CardTitle>Players online</CardTitle>
      </CardHeader>
      <CardContent>
        <ChartLoading label="Players online" />
      </CardContent>
    </Card>
  );
}

function SessionsLoading() {
  return (
    <Card aria-busy>
      <CardHeader>
        <CardTitle>Sessions</CardTitle>
      </CardHeader>
      <TableSkeleton columns={4} rows={3} />
    </Card>
  );
}

export default function PlayersTab({ server }: { server: Server }) {
  const queryClient = useQueryClient();
  const client = useRealtimeClient();
  const [dialog, setDialog] = useState<{
    action: DialogAction;
    name: string | null;
    uuid: string | null;
  } | null>(null);
  useEffect(() => preloadWhenIdle(ActionDialog.preload), []);
  const [feedback, setFeedback] = useState<Feedback | null>(null);
  const overview = useQuery({
    queryKey: qk.server(server.id).players,
    queryFn: ({ signal }) => playersApi.overview(server.id, signal),
  });

  // Live joins/leaves patch the online list and the unfiltered session list; filtered views refetch.
  useRealtimeTopic(`server:${server.id}`, (event) => {
    if (event.type !== "player.joined" && event.type !== "player.left") return;
    const parsed = REALTIME_EVENT_PAYLOADS[event.type].safeParse(event.data);
    if (!parsed.success || parsed.data.serverId !== server.id) return;
    const ev = parsed.data;
    const joined = event.type === "player.joined";
    queryClient.setQueryData<PlayersOverview>(qk.server(server.id).players, (prev) =>
      prev ? (joined ? applyJoined(prev, ev) : applyLeft(prev, ev)) : prev,
    );
    queryClient.setQueryData<InfiniteData<Page<PlayerSession>>>(
      qk.server(server.id).playerSessions(""),
      (prev) => (prev ? (joined ? sessionsJoined(prev, ev, server.id) : sessionsLeft(prev, ev)) : prev),
    );
    void queryClient.invalidateQueries({
      queryKey: qk.server(server.id).playerSessionsAll,
      predicate: (q) => q.queryKey[3] !== "",
    });
  });
  useEffect(
    () =>
      client?.onReconnect(() => {
        void queryClient.invalidateQueries({ queryKey: qk.server(server.id).players });
        void queryClient.invalidateQueries({ queryKey: qk.server(server.id).playerSessionsAll });
      }),
    [client, queryClient, server.id],
  );

  const act = useApiMutation({
    mutationFn: (body: PlayerActionRequest) => playersApi.action(server.id, body),
    silentError: true,
    onError: (err) => {
      const e = describePlayerActionError(err);
      setFeedback({ tone: e.tone, title: e.title, detail: e.detail });
    },
    onSuccess: async (r) => {
      setDialog(null);
      if (r.feedback) {
        setFeedback({
          tone: r.feedback.ok ? "success" : "warning",
          title: r.feedback.ok ? "Done" : "The server refused",
          detail: r.feedback.message,
        });
      } else {
        setFeedback({ tone: "success", title: "Saved to the server's list files", detail: null });
      }
      if (r.overview) queryClient.setQueryData(qk.server(server.id).players, r.overview);
      else await queryClient.invalidateQueries({ queryKey: qk.server(server.id).players });
    },
  });
  const run = (body: PlayerActionRequest) => {
    setFeedback(null);
    act.mutate(body);
  };
  const gate = useMemo(
    () => (a: PlayerActionKind) =>
      overview.data ? actionGate(server, overview.data, a) : { offered: false, allowed: false, reason: null },
    [server, overview.data],
  );

  if (overview.isPending) return <TableSkeleton columns={4} rows={4} />;
  if (overview.isError)
    return (
      <ErrorState
        error={overview.error}
        onRetry={() => void overview.refetch()}
        title="Could not load players"
      />
    );
  const o = overview.data;
  return (
    <div className="flex flex-col gap-3">
      {feedback ? (
        <Callout
          tone={feedback.tone}
          title={feedback.title}
          role={feedback.tone === "success" ? "status" : "alert"}
          action={
            <Button size="sm" variant="ghost" onClick={() => setFeedback(null)}>
              Dismiss
            </Button>
          }
        >
          {feedback.detail}
        </Callout>
      ) : null}
      {o.availableActions.length === 0 ? (
        <Callout tone="info">
          This server software has no player lists or moderation commands (e.g. a Velocity proxy).
        </Callout>
      ) : null}
      {o.listErrors.length ? (
        <Callout tone="warning" title="Some list entries could not be read">
          <ul className="flex flex-col gap-0.5">
            {o.listErrors.map((e, i) => (
              <li key={i}>
                <code className="font-mono">{e.file}</code>: {e.message}
              </li>
            ))}
          </ul>
        </Callout>
      ) : null}
      {o.truncated.length ? (
        <Callout tone="warning">
          Only the first 10 000 entries are shown for: {o.truncated.join(", ")}.
        </Callout>
      ) : null}
      <div className="grid gap-3 xl:grid-cols-2">
        <OnlineCard
          server={server}
          overview={o}
          gate={gate}
          open={(action, name, uuid) => setDialog({ action, name, uuid: uuid ?? null })}
          run={run}
        />
        <LazySection what="the player chart" loading={<ChartCardLoading />}>
          <MetricChart
            title="Players online"
            info="Player count over the last 24 hours, from the server's status samples."
            target={{ series: "server.players", serverId: server.id }}
            range={DAY}
          />
        </LazySection>
      </div>
      <ListsCard
        overview={o}
        gate={gate}
        open={(action, name) => setDialog({ action, name, uuid: null })}
        run={run}
        pending={act.isPending}
      />
      <LazySection what="the sessions" loading={<SessionsLoading />}>
        <SessionsCard server={server} />
      </LazySection>
      {dialog ? (
        <LazyDialog title={ACTION_TITLE[dialog.action]} onClose={() => setDialog(null)}>
          <ActionDialog
            server={server}
            action={dialog.action}
            presetName={dialog.name}
            presetUuid={dialog.uuid}
            pending={act.isPending}
            onClose={() => setDialog(null)}
            onSubmit={run}
          />
        </LazyDialog>
      ) : null}
    </div>
  );
}
