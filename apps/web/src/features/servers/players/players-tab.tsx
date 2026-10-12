import { useInfiniteQuery, useQuery, useQueryClient } from "@tanstack/react-query";
import type { InfiniteData } from "@tanstack/react-query";
import { Ban, RefreshCw, ShieldCheck, UserCheck, UserX, Users } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import type { FormEvent } from "react";
import {
  BanIpAddress,
  PlayerActionRequest,
  PlayerName,
  REALTIME_EVENT_PAYLOADS,
} from "@blockforge/contracts";
import type {
  Page,
  PlayerActionKind,
  PlayerLookupResponse,
  PlayerSession,
  PlayersOverview,
  Server,
} from "@blockforge/contracts";
import { playersApi } from "@/lib/api/phase4b-api";
import { formatDuration } from "@/lib/format";
import { useApiMutation } from "@/lib/mutations";
import { qk } from "@/lib/query-keys";
import { useRealtimeClient, useRealtimeTopic } from "@/lib/realtime/provider";
import { parseTimeRange } from "@/lib/time-range";
import { MetricChart } from "@/components/charts/metric-chart";
import { EmptyState, ErrorState, TableSkeleton } from "@/components/common/states";
import { Timestamp } from "@/components/common/timestamp";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Callout } from "@/components/ui/callout";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Field } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select } from "@/components/ui/select";
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
  stoppedOnlyReason,
} from "./player-model";

type Feedback = { tone: "success" | "warning" | "danger"; title: string; detail: string | null };
type DialogAction = "kick" | "ban" | "ban-ip" | "op" | "whitelist-add";

const ACTION_TITLE: Record<DialogAction, string> = {
  kick: "Kick a player",
  ban: "Ban a player",
  "ban-ip": "Ban an IP address",
  op: "Make a player an operator",
  "whitelist-add": "Add to the whitelist",
};

/** Actions that add a name to a list: the name is looked up (UUID + source) before sending. */
const NEEDS_LOOKUP = new Set<DialogAction>(["ban", "op", "whitelist-add"]);

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

function localInputToEpoch(value: string): number | null {
  if (!value) return null;
  const t = new Date(value).getTime();
  return Number.isFinite(t) ? t : null;
}

function ActionDialog({
  server,
  action,
  presetName,
  onClose,
  onSubmit,
  pending,
}: {
  server: Server;
  action: DialogAction;
  presetName: string | null;
  onClose: () => void;
  onSubmit: (body: PlayerActionRequest) => void;
  pending: boolean;
}) {
  const [name, setName] = useState(presetName ?? "");
  const [ip, setIp] = useState("");
  const [reason, setReason] = useState("");
  const [expires, setExpires] = useState("");
  const [level, setLevel] = useState("4");
  const [bypass, setBypass] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [lookup, setLookup] = useState<PlayerLookupResponse | null>(null);
  const [lookupError, setLookupError] = useState<string | null>(null);
  const [looking, setLooking] = useState(false);
  const stoppedReason = stoppedOnlyReason(server);
  const needsLookup = NEEDS_LOOKUP.has(action) && presetName === null;
  const lookedUp = lookup !== null && lookup.name.toLowerCase() === name.trim().toLowerCase();

  const doLookup = async () => {
    const n = PlayerName.safeParse(name.trim());
    if (!n.success) {
      setLookupError("1–16 letters, digits or underscores.");
      return;
    }
    setLooking(true);
    setLookupError(null);
    try {
      setLookup(await playersApi.lookup(server.id, n.data));
    } catch (err) {
      setLookup(null);
      setLookupError(describePlayerActionError(err).title);
    } finally {
      setLooking(false);
    }
  };

  const submit = (e: FormEvent) => {
    e.preventDefault();
    const expiresAt = localInputToEpoch(expires);
    if (expires && (expiresAt === null || expiresAt <= Date.now())) {
      setError("Choose an expiry in the future.");
      return;
    }
    const trimmedReason = reason.trim() || undefined;
    const raw =
      action === "kick"
        ? { action, name: name.trim(), reason: trimmedReason }
        : action === "ban"
          ? { action, name: name.trim(), reason: trimmedReason, ...(expiresAt ? { expiresAt } : {}) }
          : action === "ban-ip"
            ? { action, ip: ip.trim(), reason: trimmedReason, ...(expiresAt ? { expiresAt } : {}) }
            : action === "op"
              ? {
                  action,
                  name: name.trim(),
                  ...(stoppedReason ? {} : { level: Number(level), bypassesPlayerLimit: bypass }),
                }
              : { action, name: name.trim() };
    const parsed = PlayerActionRequest.safeParse(raw);
    if (!parsed.success) {
      setError(parsed.error.issues[0]?.message ?? "Check the fields.");
      return;
    }
    setError(null);
    onSubmit(parsed.data);
  };

  return (
    <Dialog open onOpenChange={(o) => !o && !pending && onClose()}>
      <DialogContent>
        <form onSubmit={submit} className="flex flex-col gap-4" noValidate>
          <DialogHeader>
            <DialogTitle>{ACTION_TITLE[action]}</DialogTitle>
            <DialogDescription>
              {stoppedReason
                ? "The server is running: this is sent as a console command and the server's reply is shown."
                : "The server is stopped: the list file is edited directly."}
            </DialogDescription>
          </DialogHeader>
          {action === "ban-ip" ? (
            <Field label="IPv4 address" hint="IP bans only match IPv4 addresses, like 203.0.113.7.">
              <Input value={ip} onChange={(e) => setIp(e.target.value)} autoFocus spellCheck={false} />
            </Field>
          ) : (
            <div className="flex items-end gap-2">
              <Field label="Player name" className="flex-1">
                <Input
                  value={name}
                  onChange={(e) => {
                    setName(e.target.value);
                    setLookup(null);
                  }}
                  readOnly={presetName !== null}
                  maxLength={16}
                  autoFocus={presetName === null}
                  spellCheck={false}
                />
              </Field>
              {needsLookup ? (
                <Button variant="outline" loading={looking} onClick={() => void doLookup()}>
                  Look up
                </Button>
              ) : null}
            </div>
          )}
          {needsLookup && lookedUp && lookup ? (
            <p className="text-xs" role="status">
              <span className="font-medium">{lookup.name}</span> ·{" "}
              <code className="font-mono">{lookup.uuid}</code> ·{" "}
              {lookup.source === "mojang"
                ? "Mojang account"
                : "offline-mode UUID (the server is not in online mode)"}
            </p>
          ) : null}
          {lookupError ? (
            <p role="alert" className="text-xs text-danger">
              {lookupError}
            </p>
          ) : null}
          {action === "kick" || action === "ban" || action === "ban-ip" ? (
            <Field label="Reason" hint="Optional, one line, at most 200 characters.">
              <Input value={reason} onChange={(e) => setReason(e.target.value)} maxLength={200} />
            </Field>
          ) : null}
          {action === "ban" || action === "ban-ip" ? (
            <Field label="Expires" hint={stoppedReason ?? "Empty = permanent."}>
              <Input
                type="datetime-local"
                value={expires}
                onChange={(e) => setExpires(e.target.value)}
                disabled={stoppedReason !== null}
              />
            </Field>
          ) : null}
          {action === "op" ? (
            <div className="flex flex-col gap-2">
              <Field
                label="Operator level"
                hint={stoppedReason ?? "4 = every command; lower levels limit commands."}
              >
                <Select
                  value={level}
                  onValueChange={setLevel}
                  disabled={stoppedReason !== null}
                  options={["1", "2", "3", "4"].map((v) => ({ value: v, label: v }))}
                />
              </Field>
              <div className="flex items-center gap-2">
                <Switch
                  id="op-bypass"
                  checked={bypass}
                  onCheckedChange={setBypass}
                  disabled={stoppedReason !== null}
                />
                <Label htmlFor="op-bypass">May join when the server is full</Label>
              </div>
              <Callout tone="warning">
                Operators can run any in-game command, including /op for others.
              </Callout>
            </div>
          ) : null}
          {error ? (
            <p role="alert" className="text-sm text-danger">
              {error}
            </p>
          ) : null}
          <DialogFooter>
            <Button variant="outline" onClick={onClose} disabled={pending}>
              Cancel
            </Button>
            <Button type="submit" loading={pending} disabled={needsLookup && !lookedUp}>
              {action === "kick"
                ? "Kick"
                : action === "op"
                  ? "Make operator"
                  : action === "whitelist-add"
                    ? "Add"
                    : "Ban"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
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
  open: (a: DialogAction, name: string | null) => void;
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
                    onClick={() => open("ban", p.name)}
                  />
                  {ops.has(p.name.toLowerCase()) ? (
                    <ActionButton
                      gate={gate("deop")}
                      label="Deop"
                      onClick={() => run({ action: "deop", name: p.name })}
                    />
                  ) : (
                    <ActionButton gate={gate("op")} label="Op" onClick={() => open("op", p.name)} />
                  )}
                  {overview.whitelist.enabled && !whitelisted.has(p.name.toLowerCase()) ? (
                    <ActionButton
                      gate={gate("whitelist-add")}
                      label="Whitelist"
                      onClick={() => run({ action: "whitelist-add", name: p.name })}
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

function SessionsCard({ server }: { server: Server }) {
  const [filter, setFilter] = useState("");
  const name = filter.trim();
  const valid = name === "" || PlayerName.safeParse(name).success;
  const q = useInfiniteQuery({
    queryKey: qk.server(server.id).playerSessions(name),
    queryFn: ({ signal, pageParam }) =>
      playersApi.sessions(server.id, { limit: 50, cursor: pageParam, name }, signal),
    initialPageParam: null as string | null,
    getNextPageParam: (last) => last.nextCursor,
    enabled: valid,
  });
  const sessions = q.data?.pages.flatMap((p) => p.items) ?? [];
  return (
    <Card>
      <CardHeader>
        <div>
          <CardTitle>Sessions</CardTitle>
          <CardDescription>Joins and leaves from the server log (kept 90 days).</CardDescription>
        </div>
        <Input
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          placeholder="Filter by name"
          aria-label="Filter sessions by player name"
          maxLength={16}
          className="w-44"
        />
      </CardHeader>
      {!valid ? (
        <p className="px-4 pb-3 text-xs text-danger">1–16 letters, digits or underscores.</p>
      ) : q.isPending ? (
        <TableSkeleton columns={4} rows={3} />
      ) : q.isError ? (
        <ErrorState
          error={q.error}
          onRetry={() => void q.refetch()}
          title="Could not load sessions"
          compact
        />
      ) : sessions.length === 0 ? (
        <EmptyState
          icon={Users}
          title={name ? "No sessions for this name" : "No sessions recorded yet"}
          compact
        />
      ) : (
        <div className="overflow-x-auto">
          <Table>
            <TableHeader>
              <TableRow className="hover:bg-transparent">
                <TableHead>Player</TableHead>
                <TableHead>Joined</TableHead>
                <TableHead>Left</TableHead>
                <TableHead>Duration</TableHead>
                <TableHead>Reason</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {sessions.map((s) => (
                <TableRow key={s.id}>
                  <TableCell className="text-sm font-medium">{s.name}</TableCell>
                  <TableCell className="text-xs">
                    <Timestamp ts={s.joinedAt} />
                  </TableCell>
                  <TableCell className="text-xs">
                    {s.leftAt ? <Timestamp ts={s.leftAt} /> : <Badge tone="success">Online</Badge>}
                  </TableCell>
                  <TableCell className="text-xs tabular">
                    {s.leftAt ? formatDuration(s.leftAt - s.joinedAt) : "—"}
                  </TableCell>
                  <TableCell className="max-w-64 text-xs break-words text-muted-foreground">
                    {s.leaveReason ?? "—"}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}
      {q.hasNextPage ? (
        <div className="flex justify-center p-2">
          <Button
            size="sm"
            variant="outline"
            loading={q.isFetchingNextPage}
            onClick={() => void q.fetchNextPage()}
          >
            Load older sessions
          </Button>
        </div>
      ) : null}
    </Card>
  );
}

const DAY = parseTimeRange("24h");

export default function PlayersTab({ server }: { server: Server }) {
  const queryClient = useQueryClient();
  const client = useRealtimeClient();
  const [dialog, setDialog] = useState<{ action: DialogAction; name: string | null } | null>(null);
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
          open={(action, name) => setDialog({ action, name })}
          run={run}
        />
        <MetricChart
          title="Players online"
          info="Player count over the last 24 hours, from the server's status samples."
          target={{ series: "server.players", serverId: server.id }}
          range={DAY}
        />
      </div>
      <ListsCard
        overview={o}
        gate={gate}
        open={(action, name) => setDialog({ action, name })}
        run={run}
        pending={act.isPending}
      />
      <SessionsCard server={server} />
      {dialog ? (
        <ActionDialog
          server={server}
          action={dialog.action}
          presetName={dialog.name}
          pending={act.isPending}
          onClose={() => setDialog(null)}
          onSubmit={run}
        />
      ) : null}
    </div>
  );
}
