import type { NodeMetricSample } from "@blockforge/contracts";
import {
  formatBytes,
  formatBytesPerSecond,
  formatMilliseconds,
  formatNumber,
  formatPercent,
  formatRate,
  percentOf,
} from "@/lib/format";
import { cn } from "@/lib/utils";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Meter } from "@/components/ui/meter";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { InfoTip, Tooltip } from "@/components/ui/tooltip";

function TileTitle({ title, info }: { title: string; info?: string }) {
  return (
    <div className="flex items-center gap-1.5">
      <CardTitle>{title}</CardTitle>
      {info ? <InfoTip label={`About ${title}`}>{info}</InfoTip> : null}
    </div>
  );
}

function Stat({
  label,
  value,
  info,
  className,
}: {
  label: string;
  value: string;
  info?: string;
  className?: string;
}) {
  return (
    <div className={cn("flex flex-col", className)}>
      <dt className="flex items-center gap-1 text-xs text-muted-foreground">
        {label}
        {info ? <InfoTip label={`About ${label}`}>{info}</InfoTip> : null}
      </dt>
      <dd className="text-sm font-semibold tabular">{value}</dd>
    </div>
  );
}

const Missing = ({ what }: { what: string }) => (
  <p className="text-sm text-muted-foreground">{what} not reported by this agent.</p>
);

/** Per-core utilisation as a single-hue heat grid; every cell also prints its value. */
export function CoreGrid({ perCore }: { perCore: number[] }) {
  return (
    <div
      className="grid grid-cols-[repeat(auto-fill,minmax(2.75rem,1fr))] gap-1"
      role="list"
      aria-label="Per-core utilisation"
    >
      {perCore.map((pct, i) => (
        <Tooltip key={i} content={`Core ${i}: ${formatPercent(pct)}`}>
          <div
            role="listitem"
            tabIndex={0}
            aria-label={`Core ${i}: ${formatPercent(pct)}`}
            className="flex h-9 flex-col items-center justify-center rounded-sm text-[10px] leading-tight tabular"
            style={{
              // Single-hue sequential ramp, capped at 70 % so foreground text keeps ≥ 4.5:1.
              background: `color-mix(in oklab, var(--chart-1) ${Math.round(12 + Math.min(100, pct) * 0.58)}%, var(--muted))`,
              color: "var(--foreground)",
            }}
          >
            <span className="opacity-80">{i}</span>
            <span className="font-semibold">{Math.round(pct)}%</span>
          </div>
        </Tooltip>
      ))}
    </div>
  );
}

export function CpuTile({
  sample,
  logicalCores,
}: {
  sample: NodeMetricSample | null;
  logicalCores: number | null;
}) {
  const cpu = sample?.cpu;
  const perCoreLoad = (v: number | undefined) =>
    v === undefined
      ? "—"
      : logicalCores
        ? `${v.toFixed(2)} (${formatPercent((v / logicalCores) * 100, 0)})`
        : v.toFixed(2);
  return (
    <Card>
      <CardHeader>
        <TileTitle
          title="CPU"
          info="Utilisation of the whole host (all processes, not only Minecraft servers)."
        />
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        {!cpu ? (
          <Missing what="CPU usage" />
        ) : (
          <>
            <Meter value={cpu.usagePct} label="Total CPU usage" size="md" />
            <dl className="grid grid-cols-2 gap-3 sm:grid-cols-5">
              <Stat
                label="Load 1m"
                value={perCoreLoad(cpu.load1)}
                info="Average number of runnable tasks over 1 minute. The percentage divides by logical cores; above 100% means tasks are waiting for CPU."
              />
              <Stat label="Load 5m" value={perCoreLoad(cpu.load5)} />
              <Stat label="Load 15m" value={perCoreLoad(cpu.load15)} />
              <Stat
                label="I/O wait"
                value={formatPercent(cpu.iowaitPct)}
                info="Time the CPU sat idle while waiting for disk or network I/O. Sustained high iowait points to slow storage."
              />
              <Stat
                label="Steal"
                value={formatPercent(cpu.stealPct)}
                info="Time a virtual machine wanted CPU but the hypervisor gave it to another guest. High steal means the host is oversubscribed."
              />
            </dl>
            {cpu.perCorePct?.length ? (
              <div className="flex flex-col gap-1.5">
                <span className="text-xs text-muted-foreground">Per core ({cpu.perCorePct.length})</span>
                <CoreGrid perCore={cpu.perCorePct} />
              </div>
            ) : (
              <p className="text-xs text-muted-foreground">Per-core utilisation not reported.</p>
            )}
          </>
        )}
      </CardContent>
    </Card>
  );
}

export function MemoryTile({ sample }: { sample: NodeMetricSample | null }) {
  const m = sample?.memory;
  if (!m) {
    return (
      <Card>
        <CardHeader>
          <TileTitle title="Memory" />
        </CardHeader>
        <CardContent>
          <Missing what="Memory usage" />
        </CardContent>
      </Card>
    );
  }
  const cached = m.cachedBytes ?? 0;
  const buffers = m.buffersBytes ?? 0;
  const free = Math.max(0, m.totalBytes - m.usedBytes - cached - buffers);
  const segments = [
    { key: "used", label: "Used", bytes: m.usedBytes, color: "var(--chart-1)" },
    { key: "buffers", label: "Buffers", bytes: m.buffersBytes, color: "var(--chart-3)" },
    { key: "cached", label: "Cached", bytes: m.cachedBytes, color: "var(--chart-7)" },
    { key: "free", label: "Free", bytes: free, color: "var(--muted)" },
  ];
  return (
    <Card>
      <CardHeader>
        <TileTitle
          title="Memory"
          info="Used is memory held by processes. Cached and buffers are reclaimable file caches the kernel frees on demand. Available estimates what can be allocated without swapping."
        />
        <span className="text-xs text-muted-foreground tabular">{formatBytes(m.totalBytes)} total</span>
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        <div
          className="flex h-3 w-full gap-0.5 overflow-hidden rounded-full"
          role="img"
          aria-label={`Memory: ${formatBytes(m.usedBytes)} used of ${formatBytes(m.totalBytes)}`}
        >
          {segments.map((s) =>
            s.bytes ? (
              <div
                key={s.key}
                title={`${s.label}: ${formatBytes(s.bytes)}`}
                style={{ width: `${percentOf(s.bytes, m.totalBytes) ?? 0}%`, background: s.color }}
              />
            ) : null,
          )}
        </div>
        <dl className="grid grid-cols-2 gap-3 sm:grid-cols-4">
          {segments.slice(0, 3).map((s) => (
            <div key={s.key} className="flex flex-col">
              <dt className="flex items-center gap-1.5 text-xs text-muted-foreground">
                <span aria-hidden className="size-2 rounded-[2px]" style={{ background: s.color }} />
                {s.label}
              </dt>
              <dd className="text-sm font-semibold tabular">
                {s.bytes === undefined ? "—" : formatBytes(s.bytes)}
              </dd>
            </div>
          ))}
          <Stat
            label="Available"
            value={formatBytes(m.availableBytes)}
            info="Memory the kernel can hand to new processes without swapping: free memory plus reclaimable cache."
          />
        </dl>
        <div className="flex flex-col gap-1">
          <div className="flex items-center justify-between text-xs">
            <span className="flex items-center gap-1 text-muted-foreground">
              Swap
              <InfoTip label="About swap">
                Disk space used as overflow memory. Regular swap use on a game host causes lag spikes.
              </InfoTip>
            </span>
            <span className="tabular">
              {m.swapTotalBytes
                ? `${formatBytes(m.swapUsedBytes)} of ${formatBytes(m.swapTotalBytes)}`
                : m.swapTotalBytes === 0
                  ? "No swap configured"
                  : "Not reported"}
            </span>
          </div>
          {m.swapTotalBytes ? (
            <Meter value={percentOf(m.swapUsedBytes, m.swapTotalBytes)} label="Swap usage" />
          ) : null}
        </div>
      </CardContent>
    </Card>
  );
}

export function FilesystemsTile({
  sample,
  dataRoot,
}: {
  sample: NodeMetricSample | null;
  dataRoot?: string;
}) {
  const fss = sample?.filesystems ?? [];
  return (
    <Card>
      <CardHeader>
        <TileTitle
          title="Filesystems"
          info="Inodes are the per-file slots of a filesystem. A disk can run out of inodes (many small files) while still having free space."
        />
        {dataRoot ? (
          <span className="truncate text-xs text-muted-foreground">
            Data root: <span className="font-mono">{dataRoot}</span>
          </span>
        ) : null}
      </CardHeader>
      {fss.length === 0 ? (
        <CardContent>
          <Missing what="Filesystem usage" />
        </CardContent>
      ) : (
        <Table>
          <TableHeader>
            <TableRow className="hover:bg-transparent">
              <TableHead>Mount</TableHead>
              <TableHead>Used</TableHead>
              <TableHead className="text-right">Free</TableHead>
              <TableHead className="text-right">Size</TableHead>
              <TableHead>Inodes used</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {fss.map((f) => (
              <TableRow key={f.mount}>
                <TableCell className="max-w-48">
                  <div className="truncate font-mono text-xs" title={f.mount}>
                    {f.mount}
                  </div>
                  <div className="truncate text-xs text-muted-foreground">
                    {[f.device, f.fsType].filter(Boolean).join(" · ") || "—"}
                  </div>
                </TableCell>
                <TableCell className="min-w-32">
                  <Meter value={percentOf(f.usedBytes, f.totalBytes)} label={`Space used on ${f.mount}`} />
                </TableCell>
                <TableCell className="text-right text-xs">{formatBytes(f.freeBytes)}</TableCell>
                <TableCell className="text-right text-xs">{formatBytes(f.totalBytes)}</TableCell>
                <TableCell className="min-w-28">
                  {f.inodesTotal ? (
                    <Meter
                      value={percentOf(f.inodesUsed, f.inodesTotal)}
                      label={`Inodes used on ${f.mount}`}
                    />
                  ) : (
                    <span className="text-xs text-muted-foreground">n/a</span>
                  )}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
    </Card>
  );
}

export function DiskIoTile({ sample }: { sample: NodeMetricSample | null }) {
  const disks = sample?.diskIo ?? [];
  return (
    <Card>
      <CardHeader>
        <TileTitle
          title="Disk I/O"
          info="Busy is the share of time the device had requests in flight. Latency is the average time per completed request; it is the best single indicator of slow storage."
        />
      </CardHeader>
      {disks.length === 0 ? (
        <CardContent>
          <Missing what="Disk I/O" />
        </CardContent>
      ) : (
        <Table>
          <TableHeader>
            <TableRow className="hover:bg-transparent">
              <TableHead>Device</TableHead>
              <TableHead className="text-right">Read</TableHead>
              <TableHead className="text-right">Write</TableHead>
              <TableHead className="text-right">IOPS r/w</TableHead>
              <TableHead className="text-right">Busy</TableHead>
              <TableHead className="text-right">Latency</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {disks.map((d) => (
              <TableRow key={d.device}>
                <TableCell className="font-mono text-xs">{d.device}</TableCell>
                <TableCell className="text-right text-xs">
                  {formatBytesPerSecond(d.readBytesPerSec)}
                </TableCell>
                <TableCell className="text-right text-xs">
                  {formatBytesPerSecond(d.writeBytesPerSec)}
                </TableCell>
                <TableCell className="text-right text-xs">
                  {formatNumber(d.readOpsPerSec, 0)} / {formatNumber(d.writeOpsPerSec, 0)}
                </TableCell>
                <TableCell className="text-right text-xs">{formatPercent(d.busyPct, 0)}</TableCell>
                <TableCell className="text-right text-xs">{formatMilliseconds(d.avgLatencyMs)}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
    </Card>
  );
}

export function NetworkTile({ sample }: { sample: NodeMetricSample | null }) {
  const ifaces = sample?.network ?? [];
  const tcp = sample?.tcp;
  return (
    <Card>
      <CardHeader>
        <TileTitle
          title="Network"
          info="Errors and drops are cumulative counters since the interface came up; a rising count indicates cabling, driver or congestion problems."
        />
        {tcp ? (
          <span className="text-xs text-muted-foreground tabular">
            TCP: <span className="font-medium text-foreground">{formatNumber(tcp.established, 0)}</span>{" "}
            established · {formatNumber(tcp.total, 0)} total
          </span>
        ) : (
          <span className="text-xs text-muted-foreground">TCP connections not reported</span>
        )}
      </CardHeader>
      {ifaces.length === 0 ? (
        <CardContent>
          <Missing what="Network traffic" />
        </CardContent>
      ) : (
        <Table>
          <TableHeader>
            <TableRow className="hover:bg-transparent">
              <TableHead>Interface</TableHead>
              <TableHead className="text-right">Receive</TableHead>
              <TableHead className="text-right">Transmit</TableHead>
              <TableHead className="text-right">Packets rx/tx</TableHead>
              <TableHead className="text-right">Errors rx/tx</TableHead>
              <TableHead className="text-right">Drops rx/tx</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {ifaces.map((n) => {
              const errs = (n.rxErrorsTotal ?? 0) + (n.txErrorsTotal ?? 0);
              const drops = (n.rxDroppedTotal ?? 0) + (n.txDroppedTotal ?? 0);
              return (
                <TableRow key={n.iface}>
                  <TableCell className="font-mono text-xs">{n.iface}</TableCell>
                  <TableCell className="text-right text-xs">
                    {formatBytesPerSecond(n.rxBytesPerSec)}
                  </TableCell>
                  <TableCell className="text-right text-xs">
                    {formatBytesPerSecond(n.txBytesPerSec)}
                  </TableCell>
                  <TableCell className="text-right text-xs">
                    {formatRate(n.rxPacketsPerSec, "", 0)} / {formatRate(n.txPacketsPerSec, "/s", 0)}
                  </TableCell>
                  <TableCell className={cn("text-right text-xs", errs > 0 && "font-medium text-warning")}>
                    {formatNumber(n.rxErrorsTotal, 0)} / {formatNumber(n.txErrorsTotal, 0)}
                  </TableCell>
                  <TableCell className={cn("text-right text-xs", drops > 0 && "font-medium text-warning")}>
                    {formatNumber(n.rxDroppedTotal, 0)} / {formatNumber(n.txDroppedTotal, 0)}
                  </TableCell>
                </TableRow>
              );
            })}
          </TableBody>
        </Table>
      )}
    </Card>
  );
}
