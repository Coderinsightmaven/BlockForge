import { randomUUID } from "node:crypto";
import {
  softwareKind,
  type CreateServerRequest,
  type Permission,
  type Server,
  type ServerOperation,
  type ServerStartup,
  type ServerSubuser,
  type Template,
} from "@blockforge/contracts";
import { buildEggEnvironment, EggEnvironmentError, resolveStartupForDisplay, validateVariableValue } from "@blockforge/eggs";
import { defaultHeapBytes, LaunchValidationError } from "@blockforge/minecraft";
import { and, asc, count, desc, eq, inArray, isNull, lt, or, sql, type SQL } from "drizzle-orm";
import type { Logger } from "pino";
import { z } from "zod";
import type { ConsoleBuffers } from "../agents/console-buffer.js";
import { commandErrorToHttp } from "../agents/errors.js";
import type { AgentGateway } from "../agents/gateway.js";
import type { NodeStateTracker } from "../agents/node-state.js";
import type { WorkloadOwnership } from "../agents/workload-ownership.js";
import { actorUserId, type AuditActor, type AuditService } from "../audit/service.js";
import type { CatalogService } from "../catalog/service.js";
import type { Db, DbOrTx, Tx } from "../db/client.js";
import {
  allocations,
  networkMembers,
  networks,
  resourceReservations,
  servers,
  serverSubusers,
  serverVariables,
  users,
} from "../db/schema/index.js";
import { withTransaction, type AfterCommit } from "../db/tx.js";
import type { EventBus } from "../events/bus.js";
import type { JobRunner } from "../jobs/runner.js";
import type { Clock } from "../lib/clock.js";
import { AppError, badRequest, conflict, forbidden, invalidState, notFound, validationDetails } from "../lib/errors.js";
import { decodeCursor, encodeCursor, TimeIdCursor } from "../lib/pagination.js";
import type { LatestCache } from "../metrics/latest.js";
import { authorize, permittedScopes, type Principal } from "../rbac/authorize.js";
import type { RealtimeHub } from "../realtime/hub.js";
import { lockNodeForPlacement, placementCandidates, serverCapacityIssues, type PlacementCandidate } from "../scheduler/placement.js";
import type { TemplatesService } from "../templates/service.js";
import type { ServerAccess, ServerAccessService } from "./access.js";
import { buildServerDtos } from "./dto.js";
import { escalation, mergeSubuserPermissions } from "./permissions.js";
import { eggEnvironment, hasControlChars, minecraftLaunch, type ServerRuntimeContext } from "./runtime.js";
import { JobError } from "../jobs/types.js";
import { SERVER_JOBS } from "./jobs.js";
import type { ServerStateService } from "./state.js";

type ServerRow = typeof servers.$inferSelect;
const HOLD_MS = 2 * 60 * 60_000;

export interface ServersDeps {
  db: Db;
  clock: Clock;
  logger: Logger;
  audit: AuditService;
  bus: EventBus;
  hub: RealtimeHub;
  tracker: NodeStateTracker;
  gateway: AgentGateway;
  latest: LatestCache;
  consoles: ConsoleBuffers;
  ownership: WorkloadOwnership;
  jobs: JobRunner;
  catalog: CatalogService;
  templates: TemplatesService;
  access: ServerAccessService;
  state: ServerStateService;
  /** Console secret masks (invalidated when variable values change). */
  masks?: { invalidate(serverId?: string): void };
}

export type ListQuery = {
  limit: number;
  cursor?: string | undefined;
  nodeId?: string | undefined;
  networkId?: string | undefined;
  state?: string | undefined;
  ownerId?: string | undefined;
  templateId?: string | undefined;
  filter: "all" | "mine";
  q?: string | undefined;
};

/** Servers: creation (placement + provisioning job), scoped listing, settings, power, console, startup, subusers. */
export class ServersService {
  constructor(private readonly d: ServersDeps) {}

  dtos(rows: ServerRow[], principal: Principal): Promise<Server[]> {
    return buildServerDtos(this.d.db, this.d.latest, rows, principal);
  }

  async dto(serverId: string, principal: Principal): Promise<Server> {
    const [row] = await this.d.db.select().from(servers).where(eq(servers.id, serverId)).limit(1);
    if (!row) throw notFound("Server");
    const [dto] = await this.dtos([row], principal);
    return dto as Server;
  }

  /**
   * `server.updated` without per-user fields (`myPermissions`, `sftp`); delivered to subscribers whose
   * effective permissions (roles ∪ ownership ∪ subuser) include servers.view.
   */
  async publishUpdated(serverId: string): Promise<void> {
    const topic = `server:${serverId}`;
    const clients = [...new Set([...this.d.hub.subscribers(topic), ...this.d.hub.subscribers("servers")])];
    if (!clients.length) return;
    const [row] = await this.d.db.select().from(servers).where(eq(servers.id, serverId)).limit(1);
    if (!row) return;
    let payload: Omit<Server, "myPermissions" | "sftp"> | null = null;
    for (const c of clients) {
      try {
        const a = await this.d.access.load(serverId, c.principal);
        if (!a?.permissions.has("servers.view")) continue;
        if (!payload) {
          const [dto] = await this.dtos([row], c.principal);
          if (!dto) return;
          const { myPermissions: _p, sftp: _s, ...rest } = dto;
          payload = rest;
        }
        for (const t of [topic, "servers"]) if (c.subscriptions.has(t)) this.d.hub.sendTo(c, t, "server.updated", payload);
      } catch (err) {
        this.d.logger.debug({ err }, "server.updated not delivered");
      }
    }
  }

  // --- Listing ------------------------------------------------------------------------

  async list(principal: Principal, q: ListQuery): Promise<{ items: Server[]; nextCursor: string | null }> {
    const scopes = permittedScopes(principal, "servers.view");
    // A subuser grant only makes a server visible when it includes servers.view (as on /servers/:id).
    const subuserOf = sql`${servers.id} IN (SELECT ${serverSubusers.serverId} FROM ${serverSubusers} WHERE ${serverSubusers.userId} = ${principal.userId} AND ${"servers.view"} = ANY(${serverSubusers.permissions}))`;
    const mine = or(eq(servers.ownerId, principal.userId), subuserOf) as SQL;
    const conds: (SQL | undefined)[] = [];
    if (q.filter === "mine") conds.push(mine);
    else if (!scopes.all) {
      const parts: SQL[] = [mine];
      if (scopes.nodeIds.size) parts.push(inArray(servers.nodeId, [...scopes.nodeIds]));
      if (scopes.serverIds.size) parts.push(inArray(servers.id, [...scopes.serverIds]));
      if (scopes.networkIds.size) {
        parts.push(sql`${servers.id} IN (SELECT ${networkMembers.serverId} FROM ${networkMembers} WHERE ${inArray(networkMembers.networkId, [...scopes.networkIds])})`);
      }
      conds.push(or(...parts));
    }
    if (q.nodeId) conds.push(eq(servers.nodeId, q.nodeId));
    if (q.state) conds.push(eq(servers.state, q.state));
    if (q.ownerId) conds.push(eq(servers.ownerId, q.ownerId));
    if (q.templateId) conds.push(eq(servers.templateId, q.templateId));
    if (q.networkId) conds.push(sql`${servers.id} IN (SELECT ${networkMembers.serverId} FROM ${networkMembers} WHERE ${networkMembers.networkId} = ${q.networkId})`);
    if (q.q) {
      const like = `%${q.q.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
      conds.push(or(sql`${servers.name} ILIKE ${like}`, sql`${servers.slug} ILIKE ${like}`));
    }
    const cursor = decodeCursor(TimeIdCursor, q.cursor);
    if (cursor) {
      const t = new Date(cursor.t);
      conds.push(or(lt(servers.createdAt, t), and(eq(servers.createdAt, t), lt(servers.id, cursor.id))));
    }
    const rows = await this.d.db
      .select()
      .from(servers)
      .where(and(...conds))
      .orderBy(desc(servers.createdAt), desc(servers.id))
      .limit(q.limit + 1);
    const page = rows.slice(0, q.limit);
    const last = page[page.length - 1];
    // Backstop: only servers the requester can view by effective permissions are returned.
    const items = (await this.dtos(page, principal)).filter((d) => d.myPermissions.includes("servers.view"));
    return { items, nextCursor: rows.length > q.limit && last ? encodeCursor({ t: last.createdAt.getTime(), id: last.id }) : null };
  }

  // --- Placement & creation -------------------------------------------------------------

  /** Candidate nodes, restricted to nodes where the user may create servers. */
  async placementPreview(principal: Principal, req: Parameters<typeof placementCandidates>[3]): Promise<PlacementCandidate[]> {
    const all = await placementCandidates(this.d.db, this.d.tracker, this.d.clock, req);
    return all.filter((c) => authorize(principal, "servers.create", { type: "node", id: c.nodeId }));
  }

  /** servers.admin on a placement target (the node, or the network the server joins). */
  private adminOn(principal: Principal, nodeId: string, networkId: string | null): boolean {
    return authorize(principal, "servers.admin", { type: "node", id: nodeId }) || (networkId !== null && authorize(principal, "servers.admin", { type: "network", id: networkId }));
  }

  private canCreateOn(principal: Principal, nodeId: string, networkId: string | null): boolean {
    return authorize(principal, "servers.create", { type: "node", id: nodeId }) || (networkId !== null && authorize(principal, "servers.create", { type: "network", id: networkId }));
  }

  async create(principal: Principal, req: CreateServerRequest, actor: AuditActor): Promise<{ server: Server; jobId: string }> {
    const template = await this.d.templates.get(req.templateId).catch(() => {
      throw badRequest("Unknown template", validationDetails("unknown template", "templateId"));
    });
    const ownerId = req.ownerId ?? principal.userId;
    const [owner] = await this.d.db.select({ id: users.id, status: users.status, username: users.username }).from(users).where(eq(users.id, ownerId)).limit(1);
    if (!owner || owner.status !== "active") throw badRequest("The owner must be an active user", validationDetails("unknown or disabled user", "ownerId"));
    if (req.networkId) {
      const [net] = await this.d.db.select({ id: networks.id }).from(networks).where(eq(networks.id, req.networkId)).limit(1);
      if (!net) throw badRequest("Unknown network", validationDetails("unknown network", "networkId"));
    }
    // Both end up in the workload environment / launch command: no line breaks or control characters.
    const boundary: { path: string; message: string }[] = [];
    if (hasControlChars(req.timezone)) boundary.push({ path: "timezone", message: "must not contain line breaks or control characters" });
    if (req.location !== null && hasControlChars(req.location)) boundary.push({ path: "location", message: "must not contain line breaks or control characters" });
    if (boundary.length) throw badRequest("Invalid server settings", { issues: boundary });
    const prepared = await this.prepareTemplateFields(template, req, principal);

    const candidates = await placementCandidates(this.d.db, this.d.tracker, this.d.clock, req);
    const permitted = candidates.filter((c) => this.canCreateOn(principal, c.nodeId, req.networkId));
    if (req.placement.mode === "node" && !permitted.length) {
      if (candidates.length) throw forbidden("You may not create servers on this node");
      throw badRequest("Unknown node", validationDetails("unknown node", "placement.nodeId"));
    }
    let fitting = permitted.filter((c) => c.fits);
    // Non-editable egg variables may only be set by holders of servers.admin on the target itself.
    const adminVars = prepared.adminOnlyVariables;
    if (adminVars.length && fitting.length) {
      fitting = fitting.filter((c) => this.adminOn(principal, c.nodeId, req.networkId));
      if (!fitting.length) {
        throw new AppError(403, "FORBIDDEN", `Setting ${adminVars.join(", ")} needs servers.admin on the target node or network`, {
          issues: adminVars.map((v) => ({ path: `egg.variables.${v}`, message: "not editable" })),
        });
      }
    }
    if (!fitting.length) {
      throw new AppError(422, "CAPACITY_EXCEEDED", "No node can host this server", {
        candidates: permitted.map((c) => ({ nodeId: c.nodeId, nodeName: c.nodeName, reasons: c.reasons })),
      });
    }
    const serverId = randomUUID();
    let chosen: PlacementCandidate | null = null;
    let jobId = "";
    for (const candidate of fitting) {
      if (req.overrideCapacity && !authorize(principal, "nodes.manage", { type: "node", id: candidate.nodeId })) {
        throw forbidden("Overriding capacity needs nodes.manage on the target node");
      }
      if (ownerId !== principal.userId && !this.adminOn(principal, candidate.nodeId, req.networkId)) {
        throw forbidden("Creating a server for another user needs servers.admin");
      }
      const result = await withTransaction(this.d.db, async (tx, after) => {
        await lockNodeForPlacement(tx, candidate.nodeId);
        const [recheck] = await placementCandidates(tx, this.d.tracker, this.d.clock, { ...req, placement: { mode: "node", nodeId: candidate.nodeId } });
        if (!recheck?.fits) return null;
        return this.insertServer(tx, after, { serverId, nodeId: candidate.nodeId, req, template, prepared, ownerId, actor, eulaBy: prepared.eulaAccepted ? principal.username : null });
      });
      if (result) {
        chosen = candidate;
        jobId = result;
        break;
      }
    }
    if (!chosen) throw new AppError(409, "CAPACITY_EXCEEDED", "The chosen node filled up concurrently; retry");
    this.d.ownership.invalidate(serverId);
    if (req.overrideCapacity && chosen.reasons.some((r) => r.startsWith("warning (override)"))) {
      await this.d.audit.record({ ...actor, action: "server.placement.override", targetType: "server", targetId: serverId, outcome: "success", details: { nodeId: chosen.nodeId, reasons: chosen.reasons } });
    }
    return { server: await this.dto(serverId, principal), jobId };
  }

  /** Validates template-specific options and derives the columns they determine. */
  private async prepareTemplateFields(template: Template, req: CreateServerRequest, principal: Principal) {
    const isBuiltin = template.kind === "minecraft" || template.kind === "velocity";
    if (isBuiltin) {
      const mc = req.minecraft;
      if (!mc) throw badRequest("This template needs `minecraft` options", validationDetails("required for this template", "minecraft"));
      if (mc.world.mode === "upload") {
        // Not implemented yet: refuse rather than silently generating a fresh world.
        throw badRequest("Creating a server from an uploaded world is not supported yet", validationDetails("not supported yet", "minecraft.world"));
      }
      if ((template.kind === "velocity") !== (mc.software === "velocity")) {
        throw badRequest(`${mc.software} cannot use the ${template.name} template`, validationDetails("software does not match the template", "minecraft.software"));
      }
      const plan = await this.d.catalog.plan(mc.software, mc.version, mc.build);
      const probe = {
        software: mc.software,
        javaMajor: mc.javaMajor,
        memoryLimitBytes: req.memoryLimitBytes,
        heapMaxBytes: mc.heapMaxBytes ?? null,
        jvmPreset: mc.jvmPreset,
        jvmArgs: mc.jvmArgs,
        timezone: req.timezone,
        artifactPlan: plan,
      } as unknown as ServerRow;
      let launch;
      try {
        launch = minecraftLaunch(probe, plan);
      } catch (err) {
        if (err instanceof LaunchValidationError) {
          throw badRequest("Invalid launch settings", { issues: err.issues.filter((i) => i.severity === "error").map((i) => ({ path: "minecraft", message: i.message })) });
        }
        throw err;
      }
      return {
        kind: softwareKind(mc.software),
        software: mc.software,
        minecraftVersion: plan.version,
        buildId: plan.build,
        javaMajor: launch.javaMajor,
        heapMaxBytes: launch.heapMaxBytes,
        dockerImage: launch.image,
        jvmArgs: mc.jvmArgs,
        jvmPreset: mc.jvmPreset,
        gameplay: mc.gameplay,
        artifactPlan: plan,
        variables: {} as Record<string, string>,
        eulaAccepted: softwareKind(mc.software) === "game" && mc.acceptEula,
        adminOnlyVariables: [] as string[],
      };
    }
    const egg = req.egg;
    if (!egg) throw badRequest("This template needs `egg` options", validationDetails("required for this template", "egg"));
    const images = template.dockerImages.map((i) => i.image);
    if (!images.length) throw badRequest("The template defines no Docker image");
    const image = egg.dockerImage ?? images[0]!;
    if (!images.includes(image)) throw badRequest("Not one of the template's images", validationDetails("not offered by the template", "egg.dockerImage"));
    // Minecraft eggs (`eula` feature): acceptance is explicit at creation; eula.txt is then written
    // during provisioning instead of the server refusing its first start.
    const needsEula = template.features.includes("eula");
    if (needsEula && !egg.acceptEula) {
      throw badRequest("This template requires accepting the Minecraft EULA", validationDetails("the Minecraft EULA must be accepted", "egg.acceptEula"));
    }
    // Non-editable variables need servers.admin on the target (checked after placement); without it
    // anywhere they are refused right away.
    const adminSomewhere = principal.grants.some((g) => g.permissions.has("servers.admin"));
    const known = new Map(template.variables.map((v) => [v.envName, v]));
    const issues: { path: string; message: string }[] = [];
    const adminOnlyVariables: string[] = [];
    for (const name of Object.keys(egg.variables)) {
      const v = known.get(name);
      if (!v) issues.push({ path: `egg.variables.${name}`, message: "unknown variable" });
      else if (!(v.userViewable && v.userEditable)) {
        if (adminSomewhere) adminOnlyVariables.push(name);
        else issues.push({ path: `egg.variables.${name}`, message: "not editable" });
      }
    }
    for (const v of template.variables) {
      const value = egg.variables[v.envName] ?? v.defaultValue;
      const err = validateVariableValue(v, value);
      if (err) issues.push({ path: `egg.variables.${v.envName}`, message: err });
      else if (hasControlChars(value)) issues.push({ path: `egg.variables.${v.envName}`, message: "must not contain line breaks or control characters" });
    }
    if (issues.length) throw badRequest("Invalid template variables", { issues });
    // Final guard: what is stored now must build an environment later (provision, every start).
    checkEggEnvironment(template, egg.variables, { memoryLimitBytes: req.memoryLimitBytes, allocationLimit: req.allocationLimit, timezone: req.timezone, location: req.location }, "egg.variables");
    return {
      kind: "game" as const,
      software: null,
      minecraftVersion: null,
      buildId: null,
      javaMajor: null,
      heapMaxBytes: null,
      dockerImage: image,
      jvmArgs: [] as string[],
      jvmPreset: null,
      gameplay: null,
      artifactPlan: null,
      variables: egg.variables,
      eulaAccepted: needsEula && egg.acceptEula,
      adminOnlyVariables,
    };
  }

  private async insertServer(
    tx: Tx,
    after: AfterCommit,
    a: {
      serverId: string;
      nodeId: string;
      req: CreateServerRequest;
      template: Template;
      prepared: Awaited<ReturnType<ServersService["prepareTemplateFields"]>>;
      ownerId: string;
      actor: AuditActor;
      eulaBy: string | null;
    },
  ): Promise<string> {
    const { req, prepared } = a;
    const [slugTaken] = await tx.select({ id: servers.id }).from(servers).where(eq(servers.slug, req.slug)).limit(1);
    if (slugTaken) throw conflict("A server with this slug already exists", validationDetails("already taken", "slug"));
    const allocCond =
      req.allocation.mode === "specific"
        ? and(eq(allocations.id, req.allocation.allocationId), eq(allocations.nodeId, a.nodeId), isNull(allocations.serverId))
        : and(eq(allocations.nodeId, a.nodeId), isNull(allocations.serverId));
    const [alloc] = await tx.select().from(allocations).where(allocCond).orderBy(asc(allocations.port)).limit(1).for("update", { skipLocked: true });
    if (!alloc) throw conflict("The allocation is no longer free");
    const now = new Date(this.d.clock.now());
    await tx.insert(servers).values({
      id: a.serverId,
      name: req.name,
      slug: req.slug,
      description: req.description,
      kind: prepared.kind,
      ownerId: a.ownerId,
      templateId: a.template.id,
      nodeId: a.nodeId,
      software: prepared.software,
      minecraftVersion: prepared.minecraftVersion,
      buildId: prepared.buildId,
      javaMajor: prepared.javaMajor,
      state: "provisioning",
      desiredState: req.startup === "auto" ? "running" : "stopped",
      activeOperation: "provision",
      memoryLimitBytes: req.memoryLimitBytes,
      heapMaxBytes: prepared.heapMaxBytes,
      cpuLimitMillicores: req.cpuLimitMillicores,
      storageQuotaBytes: req.storageQuotaBytes,
      dockerImage: prepared.dockerImage,
      allocationLimit: req.allocationLimit,
      backupLimit: req.backupLimit,
      databaseLimit: req.databaseLimit,
      jvmArgs: prepared.jvmArgs,
      jvmPreset: prepared.jvmPreset,
      gameplay: prepared.gameplay,
      artifactPlan: prepared.artifactPlan,
      startup: req.startup,
      restartPolicy: req.restartPolicy,
      eulaAcceptedAt: a.eulaBy ? now : null,
      eulaAcceptedBy: a.eulaBy,
      timezone: req.timezone,
      location: req.location,
      createdAt: now,
      updatedAt: now,
    });
    await tx.update(allocations).set({ serverId: a.serverId, isPrimary: true }).where(eq(allocations.id, alloc.id));
    const vars = Object.entries(prepared.variables);
    if (vars.length) await tx.insert(serverVariables).values(vars.map(([envName, value]) => ({ serverId: a.serverId, envName, value })));
    if (req.networkId) {
      await tx.insert(networkMembers).values({ networkId: req.networkId, serverId: a.serverId, role: "other", backendName: req.slug });
    }
    await tx.insert(resourceReservations).values({
      id: randomUUID(),
      nodeId: a.nodeId,
      serverId: a.serverId,
      kind: "hold",
      cpuMillicores: req.cpuLimitMillicores ?? 0,
      memoryBytes: req.memoryLimitBytes,
      storageBytes: req.storageQuotaBytes ?? 0,
      expiresAt: new Date(now.getTime() + HOLD_MS),
    });
    const jobId = await this.d.jobs.enqueue(
      SERVER_JOBS.provision,
      { serverId: a.serverId, eulaAcceptedBy: a.eulaBy },
      { targetType: "server", targetId: a.serverId, requestedBy: actorUserId(a.actor) },
      tx,
      after,
    );
    await this.d.state.attachJob(tx, a.serverId, jobId);
    await this.d.audit.record(
      {
        ...a.actor,
        action: "server.create",
        targetType: "server",
        targetId: a.serverId,
        outcome: "success",
        details: {
          name: req.name,
          template: a.template.key,
          nodeId: a.nodeId,
          ownerId: a.ownerId,
          allocation: `${alloc.ip}:${alloc.port}`,
          software: prepared.software,
          version: prepared.minecraftVersion,
          eulaAccepted: Boolean(a.eulaBy),
          ...(a.eulaBy ? { eulaAcceptedBy: a.eulaBy } : {}),
          jobId,
        },
      },
      tx,
    );
    await this.d.bus.publish({ type: "server.created", subjectType: "server", subjectId: a.serverId, data: { name: req.name, nodeId: a.nodeId } }, { tx, after });
    await this.d.bus.publish({ type: "server.provision.requested", subjectType: "server", subjectId: a.serverId, data: { jobId } }, { tx, after });
    return jobId;
  }

  // --- Operations ---------------------------------------------------------------------

  /** Takes the operation lock and enqueues the job in one transaction. */
  async startOperation(
    access: ServerAccess,
    op: Exclude<ServerOperation, "provision" | "update" | "backup" | "restore" | "migrate" | "extensions">,
    input: Record<string, unknown>,
    actor: AuditActor,
  ): Promise<{ jobId: string }> {
    const serverId = access.server.id;
    const type = { reinstall: SERVER_JOBS.reinstall, start: SERVER_JOBS.start, stop: SERVER_JOBS.stop, restart: SERVER_JOBS.restart, kill: SERVER_JOBS.kill, delete: SERVER_JOBS.delete }[op];
    const jobId = await withTransaction(this.d.db, async (tx, after) => {
      const { from, row } = await this.d.state.begin(tx, serverId, op);
      if (op === "reinstall") await this.reacquireResources(tx, row);
      const id = await this.d.jobs.enqueue(type, { serverId, ...input }, { targetType: "server", targetId: serverId, requestedBy: actorUserId(actor) }, tx, after);
      await this.d.state.attachJob(tx, serverId, id);
      const desired = op === "start" || op === "restart" ? "running" : op === "stop" || op === "kill" ? "stopped" : null;
      if (desired) await tx.update(servers).set({ desiredState: desired }).where(eq(servers.id, serverId));
      await this.d.audit.record({ ...actor, action: `server.${op}`, targetType: "server", targetId: serverId, outcome: "success", details: { jobId: id, from, ...input } }, tx);
      after.add(() => this.d.state.notify(serverId));
      return id;
    });
    return { jobId };
  }

  /**
   * Re-provisioning a server whose first provisioning failed: it released its allocation and hold,
   * so take a free allocation and a new hold again (capacity re-checked under the node lock).
   */
  private async reacquireResources(tx: Tx, row: ServerRow): Promise<void> {
    const [primary] = await tx.select({ id: allocations.id }).from(allocations).where(and(eq(allocations.serverId, row.id), eq(allocations.isPrimary, true))).limit(1);
    if (primary) return;
    await lockNodeForPlacement(tx, row.nodeId);
    const issues = await serverCapacityIssues(tx, this.d.clock, row.nodeId, row.id, row);
    if (issues.length) throw new AppError(422, "CAPACITY_EXCEEDED", "The server's node no longer has capacity for it", { reasons: issues });
    const [alloc] = await tx
      .select()
      .from(allocations)
      .where(and(eq(allocations.nodeId, row.nodeId), isNull(allocations.serverId)))
      .orderBy(asc(allocations.port))
      .limit(1)
      .for("update", { skipLocked: true });
    if (!alloc) throw new AppError(422, "CAPACITY_EXCEEDED", "No free allocation is left on the server's node");
    await tx.update(allocations).set({ serverId: row.id, isPrimary: true }).where(eq(allocations.id, alloc.id));
    await tx.delete(resourceReservations).where(eq(resourceReservations.serverId, row.id));
    await tx.insert(resourceReservations).values({
      id: randomUUID(),
      nodeId: row.nodeId,
      serverId: row.id,
      kind: "hold",
      cpuMillicores: row.cpuLimitMillicores ?? 0,
      memoryBytes: row.memoryLimitBytes,
      storageBytes: row.storageQuotaBytes ?? 0,
      expiresAt: new Date(this.d.clock.now() + HOLD_MS),
    });
  }

  async sendConsole(access: ServerAccess, line: string, actor: AuditActor): Promise<void> {
    const s = access.server;
    if (s.state !== "running" && s.state !== "degraded" && s.state !== "starting") throw invalidState(`The server is ${s.state}`);
    try {
      await this.d.gateway.send(s.nodeId, "workload.console", { workloadId: s.id, line }, { userId: actorUserId(actor), timeoutMs: 10_000 });
    } catch (err) {
      throw commandErrorToHttp(err);
    }
    await this.d.audit.record({ ...actor, action: "server.console.command", targetType: "server", targetId: s.id, outcome: "success", details: { command: line.slice(0, 256) } });
  }

  // --- Settings / build / suspension ----------------------------------------------------

  async updateSettings(access: ServerAccess, input: { name?: string | undefined; description?: string | undefined }, actor: AuditActor): Promise<Server> {
    const set = Object.fromEntries(Object.entries(input).filter(([, v]) => v !== undefined));
    if (Object.keys(set).length) {
      await this.d.db.update(servers).set({ ...set, updatedAt: new Date(this.d.clock.now()), version: sql`${servers.version} + 1` }).where(eq(servers.id, access.server.id));
      await this.d.audit.record({ ...actor, action: "server.settings.update", targetType: "server", targetId: access.server.id, outcome: "success", details: set });
      this.d.state.notify(access.server.id);
    }
    return this.dto(access.server.id, access.principal);
  }

  async updateBuild(
    access: ServerAccess,
    input: {
      memoryLimitBytes?: number | undefined;
      cpuLimitMillicores?: number | null | undefined;
      storageQuotaBytes?: number | null | undefined;
      allocationLimit?: number | undefined;
      backupLimit?: number | undefined;
      databaseLimit?: number | undefined;
      ownerId?: string | undefined;
      restartPolicy?: ServerRow["restartPolicy"] | undefined;
      startup?: "manual" | "auto" | undefined;
      /** Allow exceeding the node's capacity (needs nodes.manage on the node; audited). */
      overrideCapacity?: boolean | undefined;
    },
    actor: AuditActor,
  ): Promise<{ server: Server; restartRequired: boolean }> {
    const id = access.server.id;
    let restartRequired = false;
    await withTransaction(this.d.db, async (tx) => {
      // Same per-node lock as placement: concurrent creates/resizes cannot overbook the node.
      await lockNodeForPlacement(tx, access.server.nodeId);
      const [row] = await tx.select().from(servers).where(eq(servers.id, id)).for("update").limit(1);
      if (!row) throw notFound("Server");
      const set: Partial<ServerRow> = {};
      if (input.ownerId !== undefined && input.ownerId !== row.ownerId) {
        const [u] = await tx.select({ status: users.status }).from(users).where(eq(users.id, input.ownerId)).limit(1);
        if (!u || u.status !== "active") throw badRequest("The new owner must be an active user", validationDetails("unknown or disabled user", "ownerId"));
        set.ownerId = input.ownerId;
        // The new owner must not stay a subuser of their own server.
        await tx.delete(serverSubusers).where(and(eq(serverSubusers.serverId, id), eq(serverSubusers.userId, input.ownerId)));
      }
      if (input.allocationLimit !== undefined) {
        const [n] = await tx.select({ n: count() }).from(allocations).where(and(eq(allocations.serverId, id), eq(allocations.isPrimary, false)));
        if (Number(n?.n ?? 0) > input.allocationLimit) throw conflict("The server already uses more additional allocations than the new limit");
        set.allocationLimit = input.allocationLimit;
      }
      if (input.backupLimit !== undefined) set.backupLimit = input.backupLimit;
      // Lowering below the current number of databases is allowed (as for backups): no new ones until below.
      if (input.databaseLimit !== undefined) set.databaseLimit = input.databaseLimit;
      if (input.restartPolicy !== undefined) set.restartPolicy = input.restartPolicy;
      if (input.startup !== undefined) set.startup = input.startup;
      if (input.memoryLimitBytes !== undefined && input.memoryLimitBytes !== row.memoryLimitBytes) {
        set.memoryLimitBytes = input.memoryLimitBytes;
        if (row.heapMaxBytes !== null && row.heapMaxBytes >= input.memoryLimitBytes) set.heapMaxBytes = defaultHeapBytes(input.memoryLimitBytes);
        restartRequired = true;
      }
      if (input.cpuLimitMillicores !== undefined && input.cpuLimitMillicores !== row.cpuLimitMillicores) {
        set.cpuLimitMillicores = input.cpuLimitMillicores;
        restartRequired = true;
      }
      if (input.storageQuotaBytes !== undefined) set.storageQuotaBytes = input.storageQuotaBytes;
      const need = {
        memoryLimitBytes: set.memoryLimitBytes ?? row.memoryLimitBytes,
        cpuLimitMillicores: set.cpuLimitMillicores !== undefined ? set.cpuLimitMillicores : row.cpuLimitMillicores,
        storageQuotaBytes: set.storageQuotaBytes !== undefined ? set.storageQuotaBytes : row.storageQuotaBytes,
      };
      const grows =
        need.memoryLimitBytes > row.memoryLimitBytes ||
        (need.cpuLimitMillicores ?? 0) > (row.cpuLimitMillicores ?? 0) ||
        (need.storageQuotaBytes ?? 0) > (row.storageQuotaBytes ?? 0);
      if (grows) {
        const issues = await serverCapacityIssues(tx, this.d.clock, row.nodeId, id, need);
        if (issues.length) {
          if (!input.overrideCapacity) throw new AppError(409, "CAPACITY_EXCEEDED", "The node does not have enough free capacity for these limits", { reasons: issues });
          if (!authorize(access.principal, "nodes.manage", { type: "node", id: row.nodeId })) throw forbidden("Overriding capacity needs nodes.manage on the node");
          await this.d.audit.record({ ...actor, action: "server.build.override", targetType: "server", targetId: id, outcome: "success", details: { nodeId: row.nodeId, reasons: issues } }, tx);
        }
      }
      if (set.memoryLimitBytes !== undefined || set.cpuLimitMillicores !== undefined || set.storageQuotaBytes !== undefined) {
        await tx
          .update(resourceReservations)
          .set({
            memoryBytes: set.memoryLimitBytes ?? row.memoryLimitBytes,
            cpuMillicores: (set.cpuLimitMillicores !== undefined ? set.cpuLimitMillicores : row.cpuLimitMillicores) ?? 0,
            storageBytes: (set.storageQuotaBytes !== undefined ? set.storageQuotaBytes : row.storageQuotaBytes) ?? 0,
          })
          .where(eq(resourceReservations.serverId, id));
      }
      if (!Object.keys(set).length) return;
      await tx.update(servers).set({ ...set, updatedAt: new Date(this.d.clock.now()), version: row.version + 1 }).where(eq(servers.id, id));
      await this.d.audit.record({ ...actor, action: "server.build.update", targetType: "server", targetId: id, outcome: "success", details: { ...input, restartRequired } }, tx);
    });
    this.d.state.notify(id);
    return { server: await this.dto(id, access.principal), restartRequired };
  }

  async setSuspended(access: ServerAccess, suspended: boolean, actor: AuditActor): Promise<Server> {
    const id = access.server.id;
    await this.d.db.update(servers).set({ suspended, updatedAt: new Date(this.d.clock.now()) }).where(eq(servers.id, id));
    await this.d.audit.record({ ...actor, action: suspended ? "server.suspend" : "server.unsuspend", targetType: "server", targetId: id, outcome: "success" });
    await this.d.bus.publish({ type: suspended ? "server.suspended" : "server.unsuspended", subjectType: "server", subjectId: id, data: {} });
    if (suspended && ["running", "starting", "degraded"].includes(access.server.state)) {
      await this.startOperation(access, "stop", { timeoutMs: 60_000 }, actor).catch((err: unknown) =>
        this.d.logger.warn({ err, serverId: id }, "could not stop the suspended server (an operation is running)"),
      );
    }
    this.d.state.notify(id);
    return this.dto(id, access.principal);
  }

  // --- Startup -----------------------------------------------------------------------------

  async startup(access: ServerAccess): Promise<ServerStartup> {
    const template = await this.d.templates.get(access.server.templateId);
    const s = access.server;
    const admin = access.permissions.has("servers.admin");
    const canEdit = access.permissions.has("servers.startup.edit");
    const values = Object.fromEntries((await this.d.db.select().from(serverVariables).where(eq(serverVariables.serverId, s.id))).map((v) => [v.envName, v.value]));
    const visible = template.variables.filter((v) => admin || v.userViewable);
    const isViewable = (name: string) => admin || Boolean(template.variables.find((v) => v.envName === name)?.userViewable);
    const builtin = template.kind !== "egg";
    let resolved: string | null = null;
    if (!builtin) {
      const allocs = await this.d.db.select().from(allocations).where(eq(allocations.serverId, s.id));
      const rt: ServerRuntimeContext = { server: s, template: { ...(await this.d.templates.row(template.id)), variables: template.variables }, allocations: allocs, values };
      let env: Record<string, string> = values;
      try {
        env = allocs.some((a) => a.isPrimary) ? eggEnvironment(rt) : values;
      } catch (err) {
        if (!(err instanceof JobError && err.code === "INVALID_ENVIRONMENT")) throw err;
      }
      resolved = resolveStartupForDisplay(template, env, isViewable);
    }
    return {
      templateKind: template.kind,
      dockerImages: template.dockerImages,
      dockerImage: s.dockerImage,
      startupCommand: builtin ? null : template.startup,
      resolvedStartup: resolved,
      variables: visible.map((v) => ({
        envName: v.envName,
        name: v.name,
        description: v.description,
        value: admin || v.userViewable ? (values[v.envName] ?? v.defaultValue) : null,
        defaultValue: v.defaultValue,
        editable: canEdit && (admin || (v.userViewable && v.userEditable)),
        rules: v.rules,
      })),
      minecraft:
        builtin && s.software && s.minecraftVersion
          ? {
              software: s.software as NonNullable<ServerStartup["minecraft"]>["software"],
              version: s.minecraftVersion,
              build: s.buildId,
              javaMajor: s.javaMajor,
              jvmArgs: s.jvmArgs,
              jvmPreset: (s.jvmPreset ?? "default") as "default" | "aikar" | "none",
              heapMaxBytes: s.heapMaxBytes ?? defaultHeapBytes(s.memoryLimitBytes),
            }
          : null,
    };
  }

  async setVariable(access: ServerAccess, envName: string, value: string, actor: AuditActor): Promise<ServerStartup> {
    const template = await this.d.templates.get(access.server.templateId);
    const v = template.variables.find((x) => x.envName === envName);
    const admin = access.permissions.has("servers.admin");
    if (!v || (!admin && !v.userViewable)) throw notFound("Variable");
    if (!admin && !v.userEditable) throw forbidden("This variable is not editable");
    const err = validateVariableValue(v, value);
    if (err) throw badRequest(err, validationDetails(err, "value"));
    if (hasControlChars(value)) throw badRequest("Line breaks and control characters are not allowed", validationDetails("must not contain line breaks or control characters", "value"));
    const stored = Object.fromEntries((await this.d.db.select().from(serverVariables).where(eq(serverVariables.serverId, access.server.id))).map((r) => [r.envName, r.value]));
    const s = access.server;
    checkEggEnvironment(template, { ...stored, [envName]: value }, { memoryLimitBytes: s.memoryLimitBytes, allocationLimit: s.allocationLimit, timezone: s.timezone, location: s.location }, "value");
    await this.d.db
      .insert(serverVariables)
      .values({ serverId: access.server.id, envName, value })
      .onConflictDoUpdate({ target: [serverVariables.serverId, serverVariables.envName], set: { value } });
    this.d.masks?.invalidate(access.server.id);
    // Values may be secrets (passwords, tokens): only the name is audited.
    await this.d.audit.record({ ...actor, action: "server.startup.variable", targetType: "server", targetId: access.server.id, outcome: "success", details: { envName } });
    return this.startup(access);
  }

  async setImage(access: ServerAccess, image: string, actor: AuditActor): Promise<ServerStartup> {
    const template = await this.d.templates.get(access.server.templateId);
    if (template.kind !== "egg") throw badRequest("Built-in templates select the image from the Java version");
    if (!template.dockerImages.some((i) => i.image === image)) throw badRequest("Not one of the template's images", validationDetails("not offered by the template", "image"));
    await this.d.db.update(servers).set({ dockerImage: image, updatedAt: new Date(this.d.clock.now()) }).where(eq(servers.id, access.server.id));
    await this.d.audit.record({ ...actor, action: "server.startup.image", targetType: "server", targetId: access.server.id, outcome: "success", details: { image } });
    this.d.state.notify(access.server.id);
    return this.startup({ ...access, server: { ...access.server, dockerImage: image } });
  }

  // --- Subusers ------------------------------------------------------------------------------

  private async subuserDtos(serverId: string, tx: DbOrTx = this.d.db): Promise<ServerSubuser[]> {
    const rows = await tx
      .select({ sub: serverSubusers, username: users.username, email: users.email })
      .from(serverSubusers)
      .innerJoin(users, eq(users.id, serverSubusers.userId))
      .where(eq(serverSubusers.serverId, serverId))
      .orderBy(asc(serverSubusers.createdAt));
    return rows.map((r) => ({
      id: r.sub.id,
      serverId: r.sub.serverId,
      userId: r.sub.userId,
      username: r.username,
      email: r.email,
      permissions: [...r.sub.permissions].sort() as Permission[],
      createdAt: r.sub.createdAt.getTime(),
    }));
  }

  listSubusers(access: ServerAccess): Promise<ServerSubuser[]> {
    return this.subuserDtos(access.server.id);
  }

  private checkGrant(access: ServerAccess, permissions: readonly string[]): string[] {
    const unique = [...new Set(permissions)];
    const bad = escalation(unique, access.permissions);
    if (bad.length) throw new AppError(403, "FORBIDDEN", "You cannot grant permissions you do not hold on this server", { permissions: bad });
    return unique.sort();
  }

  async addSubuser(access: ServerAccess, input: { user: string; permissions: string[] }, actor: AuditActor): Promise<ServerSubuser> {
    const perms = this.checkGrant(access, input.permissions);
    const ident = input.user.trim().toLowerCase();
    const [target] = await this.d.db
      .select({ id: users.id, status: users.status })
      .from(users)
      .where(or(eq(users.email, ident), eq(users.username, ident)))
      .limit(1);
    if (!target || target.status !== "active") throw notFound("User");
    if (target.id === access.server.ownerId) throw conflict("The owner already has full access");
    if (target.id === access.principal.userId) throw forbidden("You cannot add yourself as a subuser");
    const id = randomUUID();
    const inserted = await this.d.db
      .insert(serverSubusers)
      .values({ id, serverId: access.server.id, userId: target.id, permissions: perms, createdBy: access.principal.userId })
      .onConflictDoNothing()
      .returning({ id: serverSubusers.id });
    if (!inserted.length) throw conflict("The user is already a subuser of this server");
    await this.d.audit.record({ ...actor, action: "server.subuser.add", targetType: "server", targetId: access.server.id, outcome: "success", details: { userId: target.id, permissions: perms } });
    return (await this.subuserDtos(access.server.id)).find((s) => s.id === id) as ServerSubuser;
  }

  async updateSubuser(access: ServerAccess, subuserId: string, permissions: string[], actor: AuditActor): Promise<ServerSubuser> {
    const [row] = await this.d.db.select().from(serverSubusers).where(and(eq(serverSubusers.id, subuserId), eq(serverSubusers.serverId, access.server.id))).limit(1);
    if (!row) throw notFound("Subuser");
    if (row.userId === access.principal.userId) throw forbidden("You cannot change your own subuser permissions");
    // Requesting a permission the granter does not hold (and the subuser lacks) is escalation.
    this.checkGrant(access, permissions.filter((p) => !row.permissions.includes(p)));
    const perms = mergeSubuserPermissions(row.permissions, permissions, access.permissions);
    if (!perms.length) throw badRequest("A subuser needs at least one permission", validationDetails("empty permission set", "permissions"));
    await this.d.db.update(serverSubusers).set({ permissions: perms, updatedAt: new Date(this.d.clock.now()) }).where(eq(serverSubusers.id, subuserId));
    await this.d.audit.record({ ...actor, action: "server.subuser.update", targetType: "server", targetId: access.server.id, outcome: "success", details: { userId: row.userId, permissions: perms, previous: row.permissions } });
    return (await this.subuserDtos(access.server.id)).find((s) => s.id === subuserId) as ServerSubuser;
  }

  async removeSubuser(access: ServerAccess, subuserId: string, actor: AuditActor): Promise<void> {
    const deleted = await this.d.db
      .delete(serverSubusers)
      .where(and(eq(serverSubusers.id, subuserId), eq(serverSubusers.serverId, access.server.id)))
      .returning({ userId: serverSubusers.userId });
    if (!deleted.length) throw notFound("Subuser");
    await this.d.audit.record({ ...actor, action: "server.subuser.remove", targetType: "server", targetId: access.server.id, outcome: "success", details: { userId: deleted[0]!.userId } });
  }
}

export const ServerIdParams = z.object({ id: z.uuid() });

/**
 * Builds the egg environment for values about to be stored (authorised by the caller, hence
 * `adminOverride`) and turns an EggEnvironmentError into VALIDATION_FAILED at `path`.
 */
function checkEggEnvironment(
  template: Template,
  values: Record<string, string>,
  s: { memoryLimitBytes: number; allocationLimit: number; timezone: string; location: string | null },
  path: string,
): void {
  if (template.kind !== "egg") return;
  try {
    buildEggEnvironment(
      {
        template: { startup: template.startup, variables: template.variables },
        values,
        memoryLimitBytes: s.memoryLimitBytes,
        // Placeholder allocation and id: only the variable values are under test here.
        primary: { ip: "0.0.0.0", port: 25565 },
        serverId: "00000000-0000-4000-8000-000000000000",
        location: s.location,
        allocationLimit: s.allocationLimit,
        timezone: s.timezone,
      },
      { adminOverride: true },
    );
  } catch (err) {
    if (err instanceof EggEnvironmentError) throw badRequest("Invalid template variables", validationDetails(err.message, path));
    throw err;
  }
}
