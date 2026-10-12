import { CircleCheck, CircleX } from "lucide-react";
import type { ReactNode } from "react";
import type { Node } from "@blockforge/contracts";
import { formatBytes, formatDuration, formatMillicores, formatPercent, percentOf } from "@/lib/format";
import { useNow, Timestamp } from "@/components/common/timestamp";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Meter } from "@/components/ui/meter";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { InfoTip } from "@/components/ui/tooltip";

function Row({ label, children, info }: { label: string; children: ReactNode; info?: string }) {
  return (
    <div className="grid grid-cols-[9rem_1fr] gap-2 py-1 text-sm">
      <dt className="flex items-center gap-1 text-muted-foreground">
        {label}
        {info ? <InfoTip label={`About ${label}`}>{info}</InfoTip> : null}
      </dt>
      <dd className="min-w-0 break-words">{children ?? <span className="text-muted-foreground">—</span>}</dd>
    </div>
  );
}

const orDash = (v: string | number | null | undefined) =>
  v === null || v === undefined || v === "" ? <span className="text-muted-foreground">—</span> : v;

export function SystemFacts({ node }: { node: Node }) {
  const now = useNow();
  const f = node.facts;
  return (
    <Card>
      <CardHeader>
        <CardTitle>System</CardTitle>
      </CardHeader>
      <CardContent>
        {!f ? (
          <p className="text-sm text-muted-foreground">The agent has not reported system facts yet.</p>
        ) : (
          <dl className="divide-y">
            <Row label="Hostname">{f.hostname}</Row>
            <Row label="Operating system">
              {[f.platform ?? f.os, f.platformVersion].filter(Boolean).join(" ") || f.os}
            </Row>
            <Row label="Kernel">{orDash(f.kernelVersion)}</Row>
            <Row label="Architecture">{f.arch}</Row>
            <Row label="CPU model">{orDash(f.cpuModel)}</Row>
            <Row
              label="Cores"
              info="Physical cores are hardware cores; logical cores include hyper-threads (what the OS schedules on)."
            >
              {f.cpuPhysicalCores ?? "—"} physical · {f.cpuLogicalCores} logical
            </Row>
            <Row label="Memory">
              {formatBytes(f.memoryTotalBytes)}
              {f.swapTotalBytes !== undefined ? ` · swap ${formatBytes(f.swapTotalBytes)}` : ""}
            </Row>
            <Row label="Uptime">
              {f.bootTime ? (
                <>
                  {formatDuration(now - f.bootTime)}{" "}
                  <span className="text-muted-foreground">
                    (booted <Timestamp ts={f.bootTime} mode="absolute" />)
                  </span>
                </>
              ) : (
                "—"
              )}
            </Row>
            <Row label="Time zone">{orDash(f.timezone)}</Row>
            <Row
              label="Clock skew"
              info="Difference between the node clock and the control plane. Large skew breaks signed-command expiry and makes timestamps misleading."
            >
              {node.clockSkewMs === null ? "—" : `${node.clockSkewMs > 0 ? "+" : ""}${node.clockSkewMs} ms`}
            </Row>
            <Row label="Data root">
              <span className="font-mono text-xs">{f.dataRoot}</span>
            </Row>
            <Row label="Agent version">
              <span className="font-mono text-xs">{orDash(node.agentVersion)}</span>
            </Row>
            <Row label="Last connected">
              <Timestamp ts={node.lastConnectedAt} />
            </Row>
          </dl>
        )}
      </CardContent>
    </Card>
  );
}

export function RuntimeFacts({ node }: { node: Node }) {
  const rt = node.facts?.containerRuntime ?? null;
  const java = node.facts?.javaRuntimes ?? [];
  return (
    <Card>
      <CardHeader>
        <CardTitle>Runtimes</CardTitle>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        {!node.facts ? (
          <p className="text-sm text-muted-foreground">Not reported yet.</p>
        ) : !rt ? (
          <p className="text-sm text-muted-foreground">
            No container runtime detected. Servers cannot run on this node until Docker or Podman is
            available.
          </p>
        ) : (
          <dl className="divide-y">
            <Row label="Container runtime">
              <span className="inline-flex flex-wrap items-center gap-2">
                <span className="capitalize">{rt.name}</span>{" "}
                <span className="font-mono text-xs">{rt.version}</span>
                {rt.healthy ? (
                  <Badge tone="success">
                    <CircleCheck aria-hidden /> Healthy
                  </Badge>
                ) : (
                  <Badge tone="danger">
                    <CircleX aria-hidden /> Unhealthy
                  </Badge>
                )}
              </span>
            </Row>
            {rt.error ? (
              <Row label="Runtime error">
                <span className="text-danger">{rt.error}</span>
              </Row>
            ) : null}
            <Row label="API version">{orDash(rt.apiVersion)}</Row>
            <Row label="Mode">{rt.rootless ? "Rootless" : "Rootful"}</Row>
            <Row label="cgroup">{orDash(rt.cgroupVersion)}</Row>
            <Row label="Storage driver">{orDash(rt.storageDriver)}</Row>
          </dl>
        )}
        <div>
          <h3 className="mb-1.5 text-xs font-medium text-muted-foreground">Java runtimes</h3>
          {java.length === 0 ? (
            <p className="text-sm text-muted-foreground">None detected.</p>
          ) : (
            <ul className="flex flex-col gap-1">
              {java.map((j) => (
                <li key={`${j.source}:${j.ref}`} className="flex flex-wrap items-center gap-2 text-sm">
                  <Badge variant="outline">Java {j.major}</Badge>
                  <span className="font-mono text-xs">{j.version}</span>
                  {j.vendor ? <span className="text-xs text-muted-foreground">{j.vendor}</span> : null}
                  <span className="truncate font-mono text-xs text-muted-foreground" title={j.ref}>
                    {j.source === "image" ? "image" : "host"}: {j.ref}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </div>
      </CardContent>
    </Card>
  );
}

export function CapacityFacts({ node }: { node: Node }) {
  const c = node.capacity;
  const rows = [
    {
      label: "CPU",
      reserved: formatMillicores(c.cpuReservedMillicores),
      allocatable: formatMillicores(c.cpuAllocatableMillicores),
      pct: percentOf(c.cpuReservedMillicores, c.cpuAllocatableMillicores),
    },
    {
      label: "Memory",
      reserved: formatBytes(c.memoryReservedBytes),
      allocatable: formatBytes(c.memoryAllocatableBytes),
      pct: percentOf(c.memoryReservedBytes, c.memoryAllocatableBytes),
    },
    {
      label: "Storage",
      reserved: formatBytes(c.storageReservedBytes),
      allocatable: formatBytes(c.storageAllocatableBytes),
      pct: percentOf(c.storageReservedBytes, c.storageAllocatableBytes),
    },
  ];
  return (
    <Card>
      <CardHeader>
        <div className="flex items-center gap-1.5">
          <CardTitle>Allocation</CardTitle>
          <InfoTip label="About allocation">
            Resources reserved by servers (and in-flight provisioning) out of what this node offers to
            BlockForge. This is a reservation, not measured usage. Memory may be overcommitted up to the
            configured ratio.
          </InfoTip>
        </div>
        <span className="text-xs text-muted-foreground tabular">Overcommit ×{c.overcommitMemoryRatio}</span>
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        {rows.map((r) => (
          <div key={r.label} className="flex flex-col gap-1">
            <div className="flex justify-between text-xs">
              <span className="font-medium">{r.label}</span>
              <span className="tabular">
                {r.reserved}{" "}
                <span className="text-muted-foreground">
                  of {r.allocatable} · {formatPercent(r.pct, 0)}
                </span>
              </span>
            </div>
            <Meter
              value={r.pct}
              label={`${r.label} reserved`}
              showValue={false}
              fill="bg-allocated"
              thresholds={null}
            />
          </div>
        ))}
        <div className="flex justify-between text-xs">
          <span className="text-muted-foreground">Servers on this node</span>
          <span className="font-medium tabular">{node.serverCount}</span>
        </div>
      </CardContent>
    </Card>
  );
}

export function InterfacesFacts({ node }: { node: Node }) {
  const ifaces = node.facts?.interfaces ?? [];
  return (
    <Card>
      <CardHeader>
        <CardTitle>Network interfaces</CardTitle>
        <span className="text-xs text-muted-foreground">
          Public {node.publicAddress ?? "—"} · Private {node.privateAddress ?? "—"}
        </span>
      </CardHeader>
      {ifaces.length === 0 ? (
        <CardContent>
          <p className="text-sm text-muted-foreground">Not reported yet.</p>
        </CardContent>
      ) : (
        <Table>
          <TableHeader>
            <TableRow className="hover:bg-transparent">
              <TableHead>Name</TableHead>
              <TableHead>State</TableHead>
              <TableHead>Addresses</TableHead>
              <TableHead>MAC</TableHead>
              <TableHead className="text-right">MTU</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {ifaces.map((i) => (
              <TableRow key={i.name}>
                <TableCell className="font-mono text-xs">{i.name}</TableCell>
                <TableCell className="text-xs">{i.up === undefined ? "—" : i.up ? "Up" : "Down"}</TableCell>
                <TableCell>
                  <div className="flex flex-col font-mono text-xs">
                    {i.addresses.length ? (
                      i.addresses.map((a) => <span key={a}>{a}</span>)
                    ) : (
                      <span className="text-muted-foreground">—</span>
                    )}
                  </div>
                </TableCell>
                <TableCell className="font-mono text-xs">{i.mac ?? "—"}</TableCell>
                <TableCell className="text-right text-xs">{i.mtu ?? "—"}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
    </Card>
  );
}

export function FilesystemFacts({ node }: { node: Node }) {
  const fss = node.facts?.filesystems ?? [];
  if (fss.length === 0) return null;
  return (
    <Card>
      <CardHeader>
        <CardTitle>Mounts</CardTitle>
      </CardHeader>
      <Table>
        <TableHeader>
          <TableRow className="hover:bg-transparent">
            <TableHead>Mount</TableHead>
            <TableHead>Device</TableHead>
            <TableHead>Type</TableHead>
            <TableHead className="text-right">Size</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {fss.map((f) => (
            <TableRow key={f.mount}>
              <TableCell className="font-mono text-xs">{f.mount}</TableCell>
              <TableCell className="font-mono text-xs">{f.device ?? "—"}</TableCell>
              <TableCell className="text-xs">{f.fsType ?? "—"}</TableCell>
              <TableCell className="text-right text-xs">{formatBytes(f.totalBytes)}</TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </Card>
  );
}
