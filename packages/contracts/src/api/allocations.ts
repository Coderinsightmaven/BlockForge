import { z } from "zod";
import { EpochMs, Id, Port } from "../common.js";

/**
 * A bindable IP:port on a node (Pterodactyl "allocation"). Admins create pools per node; each server
 * has one primary allocation plus up to `allocationLimit` additional ones. The container port equals the
 * host port, both TCP and UDP are published, and the server learns it via `SERVER_PORT` / server.properties.
 */
export const Allocation = z.object({
  id: Id,
  nodeId: Id,
  /** Bind address on the node: a node IP, or "0.0.0.0" for all interfaces. */
  ip: z.union([z.ipv4(), z.ipv6()]),
  port: Port,
  /** Public hostname/IP shown to users instead of `ip` (e.g. play.example.com). */
  alias: z.string().max(253).nullable(),
  notes: z.string().max(256).nullable(),
  serverId: Id.nullable(),
  serverName: z.string().nullable(),
  primary: z.boolean(),
  createdAt: EpochMs,
});
export type Allocation = z.infer<typeof Allocation>;

/** Port list like "25570-25600,25610". At most 1000 ports per request. */
export const PortList = z
  .string()
  .max(512)
  .regex(/^\s*\d{1,5}(\s*-\s*\d{1,5})?(\s*,\s*\d{1,5}(\s*-\s*\d{1,5})?)*\s*$/, "use ports and ranges, e.g. 25570-25600,25610");

export function expandPortList(list: string): number[] {
  const out = new Set<number>();
  for (const part of list.split(",")) {
    const [a, b] = part.split("-").map((x) => Number(x.trim()));
    if (a === undefined || !Number.isInteger(a)) continue;
    const end = b === undefined ? a : b;
    if (a < 1 || end > 65535 || end < a) throw new Error(`invalid range ${part.trim()}`);
    for (let p = a; p <= end; p++) out.add(p);
    if (out.size > 1000) throw new Error("at most 1000 ports per request");
  }
  return [...out].sort((x, y) => x - y);
}

export const CreateAllocationsRequest = z.object({
  ip: z.union([z.ipv4(), z.ipv6()]),
  ports: PortList,
  alias: z.string().max(253).nullable().default(null),
});
export const CreateAllocationsResponse = z.object({
  created: z.number().int(),
  /** Ports that already existed for this ip on the node. */
  skipped: z.array(Port),
  /** e.g. ports currently listening on the node (reported by the agent) — likely used by other software. */
  warnings: z.array(z.string()),
});
export const UpdateAllocationRequest = z.object({
  alias: z.string().max(253).nullable().optional(),
  notes: z.string().max(256).nullable().optional(),
});
export const AllocationListQuery = z.object({
  limit: z.coerce.number().int().min(1).max(500).default(100),
  cursor: z.string().optional(),
  /** `?free=true|false` (`z.coerce.boolean` would treat "false" as true). */
  free: z.stringbool().optional(),
});

/** Server-side allocation management (`servers.allocations.manage`). Changes apply on next restart. */
export const UpdateServerAllocationRequest = z.object({
  notes: z.string().max(256).nullable().optional(),
  primary: z.literal(true).optional(),
});
export const ServerAllocationChangeResponse = z.object({
  allocation: Allocation,
  restartRequired: z.boolean(),
});
