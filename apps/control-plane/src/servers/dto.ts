import type { Server, ServerSoftware } from "@blockforge/contracts";
import { and, asc, eq, inArray } from "drizzle-orm";
import type { Db } from "../db/client.js";
import type { servers} from "../db/schema/index.js";
import { allocations, networkMembers, nodes, serverSubusers, templates, users } from "../db/schema/index.js";
import type { LatestCache } from "../metrics/latest.js";
import type { Principal } from "../rbac/authorize.js";
import { effectiveServerPermissions, permissionList, type ServerResource } from "./permissions.js";

type ServerRow = typeof servers.$inferSelect;
const WILDCARD_IPS = new Set(["0.0.0.0", "::"]);

/** First 8 hex characters of the server id (SFTP usernames `<username>.<shortId>`). */
export function shortId(serverId: string): string {
  return serverId.replace(/-/g, "").slice(0, 8);
}

function hostPort(host: string, port: number): string {
  return host.includes(":") ? `[${host}]:${port}` : `${host}:${port}`;
}

/** Builds `Server` DTOs for one requesting user with batched lookups (no per-row queries). */
export async function buildServerDtos(db: Db, latest: LatestCache, rows: ServerRow[], principal: Principal): Promise<Server[]> {
  if (!rows.length) return [];
  const ids = rows.map((r) => r.id);
  const nodeIds = [...new Set(rows.map((r) => r.nodeId))];
  const templateIds = [...new Set(rows.map((r) => r.templateId))];
  const ownerIds = [...new Set(rows.map((r) => r.ownerId))];
  const [nodeRows, templateRows, ownerRows, allocRows, memberRows, subRows] = await Promise.all([
    db.select({ id: nodes.id, name: nodes.name, publicAddress: nodes.publicAddress, facts: nodes.facts }).from(nodes).where(inArray(nodes.id, nodeIds)),
    db.select({ id: templates.id, name: templates.name, kind: templates.kind, game: templates.game }).from(templates).where(inArray(templates.id, templateIds)),
    db.select({ id: users.id, username: users.username }).from(users).where(inArray(users.id, ownerIds)),
    db.select().from(allocations).where(inArray(allocations.serverId, ids)).orderBy(asc(allocations.port)),
    db.select({ serverId: networkMembers.serverId, networkId: networkMembers.networkId }).from(networkMembers).where(inArray(networkMembers.serverId, ids)),
    db
      .select({ serverId: serverSubusers.serverId, permissions: serverSubusers.permissions })
      .from(serverSubusers)
      .where(and(inArray(serverSubusers.serverId, ids), eq(serverSubusers.userId, principal.userId))),
  ]);
  const nodeMap = new Map(nodeRows.map((n) => [n.id, n]));
  const tplMap = new Map(templateRows.map((t) => [t.id, t]));
  const ownerMap = new Map(ownerRows.map((u) => [u.id, u.username]));
  const netMap = new Map(memberRows.map((m) => [m.serverId, m.networkId]));
  const subMap = new Map(subRows.map((s) => [s.serverId, s.permissions]));
  const allocMap = new Map<string, (typeof allocRows)[number][]>();
  for (const a of allocRows) {
    if (!a.serverId) continue;
    const list = allocMap.get(a.serverId) ?? [];
    list.push(a);
    allocMap.set(a.serverId, list);
  }
  return rows.map((r) => {
    const node = nodeMap.get(r.nodeId);
    const tpl = tplMap.get(r.templateId);
    const allocs = (allocMap.get(r.id) ?? []).sort((a, b) => Number(b.isPrimary) - Number(a.isPrimary) || a.port - b.port);
    const primary = allocs.find((a) => a.isPrimary) ?? null;
    const resource: ServerResource = { type: "server", id: r.id, nodeId: r.nodeId, networkId: netMap.get(r.id) ?? null };
    const perms = effectiveServerPermissions(principal, { resource, ownerId: r.ownerId, suspended: r.suspended, subuserPermissions: subMap.get(r.id) ?? null });
    const publicHost = primary ? (primary.alias ?? node?.publicAddress ?? (WILDCARD_IPS.has(primary.ip) ? null : primary.ip)) : null;
    const sftpFact = node?.facts?.sftp ?? null;
    const sftpHost = node?.publicAddress ?? (primary && !WILDCARD_IPS.has(primary.ip) ? primary.ip : null);
    return {
      id: r.id,
      shortId: shortId(r.id),
      name: r.name,
      slug: r.slug,
      description: r.description,
      kind: r.kind as Server["kind"],
      ownerId: r.ownerId,
      ownerName: ownerMap.get(r.ownerId) ?? "",
      templateId: r.templateId,
      templateName: tpl?.name ?? "",
      templateKind: (tpl?.kind ?? "egg") as Server["templateKind"],
      game: (tpl?.game ?? "other") as Server["game"],
      nodeId: r.nodeId,
      nodeName: node?.name ?? "",
      networkId: netMap.get(r.id) ?? null,
      software: (r.software as ServerSoftware | null) ?? null,
      minecraftVersion: r.minecraftVersion,
      build: r.buildId,
      javaMajor: r.javaMajor,
      heapMaxBytes: r.heapMaxBytes,
      dockerImage: r.dockerImage,
      state: r.state as Server["state"],
      desiredState: r.desiredState as Server["desiredState"],
      activeOperation: (r.activeOperation as Server["activeOperation"]) ?? null,
      activeJobId: r.activeJobId,
      suspended: r.suspended,
      memoryLimitBytes: r.memoryLimitBytes,
      cpuLimitMillicores: r.cpuLimitMillicores,
      storageQuotaBytes: r.storageQuotaBytes,
      allocationLimit: r.allocationLimit,
      backupLimit: r.backupLimit,
      allocations: allocs.map((a) => ({ id: a.id, ip: a.ip, port: a.port, alias: a.alias, primary: a.isPrimary })),
      address: primary && publicHost ? hostPort(publicHost, primary.port) : null,
      startup: r.startup as Server["startup"],
      restartPolicy: r.restartPolicy,
      timezone: r.timezone,
      location: r.location,
      lastStartedAt: r.lastStartedAt?.getTime() ?? null,
      lastCrashAt: r.lastCrashAt?.getTime() ?? null,
      lastExitCode: r.lastExitCode,
      createdAt: r.createdAt.getTime(),
      latest: latest.getWorkload(r.id),
      myPermissions: permissionList(perms),
      sftp:
        perms.has("servers.files.sftp") && sftpFact && sftpHost
          ? { host: sftpHost, port: sftpFact.port, username: `${principal.username}.${shortId(r.id)}`, hostKeyFingerprint: sftpFact.hostKeyFingerprint }
          : null,
    };
  });
}
