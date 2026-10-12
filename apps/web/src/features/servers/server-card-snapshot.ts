import type { Server } from "@blockforge/contracts";
import { formatBytes } from "@/lib/format";
import { cpuView, memoryView, playersView } from "@/lib/server-metrics";

export function softwareLabel(s: Pick<Server, "software" | "minecraftVersion" | "templateName">): string {
  if (s.software)
    return `${s.software[0]!.toUpperCase()}${s.software.slice(1)} ${s.minecraftVersion ?? ""}`.trim();
  return s.templateName;
}

const round1 = (n: number | null) => (n === null ? "-" : n.toFixed(1));

/**
 * Exactly what a server card renders. Every `server.updated` / metrics event replaces the server
 * object, but most change nothing visible on the card (e.g. a sample with the same rounded values);
 * comparing this snapshot lets the card skip those re-renders on a dashboard with hundreds of servers.
 */
export function serverCardSnapshot(server: Server): string {
  const cpu = cpuView(server.latest, server.cpuLimitMillicores);
  const mem = memoryView(server);
  const players = playersView(server);
  return JSON.stringify([
    server.id,
    server.name,
    softwareLabel(server),
    server.nodeName,
    server.state,
    server.suspended,
    server.address,
    cpu.text,
    round1(cpu.pctOfLimit),
    formatBytes(mem.used),
    formatBytes(mem.limit),
    round1(mem.pct),
    players ? `${players.online}/${players.max}` : null,
  ]);
}
