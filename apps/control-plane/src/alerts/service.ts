import { randomUUID } from "node:crypto";
import { ALERT_RULE_KINDS, type AlertIncident, type AlertRule } from "@blockforge/contracts";
import { and, asc, desc, eq, inArray, lt, ne, or, type SQL } from "drizzle-orm";
import type { Logger } from "pino";
import type { AuditActor, AuditService } from "../audit/service.js";
import type { Db } from "../db/client.js";
import { alertIncidents, alertRules, users } from "../db/schema/index.js";
import { withTransaction } from "../db/tx.js";
import type { EventBus } from "../events/bus.js";
import type { Clock } from "../lib/clock.js";
import { badRequest, invalidState, notFound, validationDetails } from "../lib/errors.js";
import type { TimeIdCursor } from "../lib/pagination.js";
import type { NotificationService } from "../notifications/service.js";
import type { RealtimeHub } from "../realtime/hub.js";
import type { Resource } from "../rbac/authorize.js";
import type { RbacService } from "../rbac/service.js";

type RuleRow = typeof alertRules.$inferSelect;
type IncidentRow = typeof alertIncidents.$inferSelect;
export type RuleInput = Omit<AlertRule, "id">;

/** Default rules seeded idempotently (keyed by `builtin_key`; user edits are preserved). */
export const DEFAULT_RULES: (RuleInput & { builtinKey: string })[] = [
  { builtinKey: "node-unreachable", name: "Node unreachable", kind: "node.unreachable", severity: "critical", enabled: true, scopeType: "global", scopeId: null, threshold: null, forSeconds: 0, cooldownSeconds: 900, channelIds: [] },
  { builtinKey: "node-cpu-high", name: "Node CPU above 90%", kind: "node.cpu.high", severity: "warning", enabled: true, scopeType: "global", scopeId: null, threshold: 90, forSeconds: 300, cooldownSeconds: 900, channelIds: [] },
  { builtinKey: "node-memory-high", name: "Node memory above 90%", kind: "node.memory.high", severity: "warning", enabled: true, scopeType: "global", scopeId: null, threshold: 90, forSeconds: 300, cooldownSeconds: 900, channelIds: [] },
  { builtinKey: "node-disk-warning", name: "Filesystem below 10% free", kind: "node.disk.low", severity: "warning", enabled: true, scopeType: "global", scopeId: null, threshold: 10, forSeconds: 60, cooldownSeconds: 1800, channelIds: [] },
  { builtinKey: "node-disk-critical", name: "Filesystem below 5% free", kind: "node.disk.low", severity: "critical", enabled: true, scopeType: "global", scopeId: null, threshold: 5, forSeconds: 60, cooldownSeconds: 1800, channelIds: [] },
  { builtinKey: "job-failed", name: "Job failed", kind: "job.failed", severity: "warning", enabled: true, scopeType: "global", scopeId: null, threshold: null, forSeconds: 0, cooldownSeconds: 900, channelIds: [] },
];

export function ruleResource(rule: Pick<AlertRule, "scopeType" | "scopeId">): { type: string; id: string | null } {
  return { type: rule.scopeType, id: rule.scopeId };
}

export class AlertService {
  constructor(
    private readonly db: Db,
    private readonly clock: Clock,
    private readonly audit: AuditService,
    private readonly bus: EventBus,
    private readonly hub: RealtimeHub,
    private readonly rbac: RbacService,
    private readonly notifications: NotificationService,
    private readonly logger: Logger,
  ) {}

  ruleDto(r: RuleRow): AlertRule {
    return {
      id: r.id,
      name: r.name,
      kind: r.kind as AlertRule["kind"],
      severity: r.severity as AlertRule["severity"],
      enabled: r.enabled,
      scopeType: r.scopeType as AlertRule["scopeType"],
      scopeId: r.scopeId,
      threshold: r.threshold,
      forSeconds: r.forSeconds,
      cooldownSeconds: r.cooldownSeconds,
      channelIds: r.channelIds,
    };
  }

  async incidentDtos(rows: IncidentRow[]): Promise<AlertIncident[]> {
    const ackIds = [...new Set(rows.map((r) => r.acknowledgedBy).filter((x): x is string => Boolean(x)))];
    const names = new Map<string, string>();
    if (ackIds.length) for (const u of await this.db.select({ id: users.id, email: users.email }).from(users).where(inArray(users.id, ackIds))) names.set(u.id, u.email);
    return rows.map((r) => ({
      id: r.id,
      ruleId: r.ruleId,
      kind: r.kind as AlertIncident["kind"],
      severity: r.severity as AlertIncident["severity"],
      status: r.status as AlertIncident["status"],
      subjectType: r.subjectType,
      subjectId: r.subjectId,
      subjectName: r.subjectName,
      summary: r.summary,
      value: r.value,
      firstFiredAt: r.firstFiredAt.getTime(),
      lastFiredAt: r.lastFiredAt.getTime(),
      acknowledgedAt: r.acknowledgedAt?.getTime() ?? null,
      acknowledgedBy: r.acknowledgedBy ? (names.get(r.acknowledgedBy) ?? null) : null,
      resolvedAt: r.resolvedAt?.getTime() ?? null,
      occurrences: r.occurrences,
    }));
  }

  async seedDefaults(): Promise<void> {
    for (const r of DEFAULT_RULES) {
      await this.db
        .insert(alertRules)
        .values({ id: randomUUID(), ...r })
        .onConflictDoNothing({ target: alertRules.builtinKey });
    }
  }

  // --- Rules ---------------------------------------------------------------------

  async listRules(): Promise<AlertRule[]> {
    const rows = await this.db.select().from(alertRules).orderBy(asc(alertRules.createdAt));
    return rows.map((r) => this.ruleDto(r));
  }

  async getRule(id: string): Promise<AlertRule> {
    const [row] = await this.db.select().from(alertRules).where(eq(alertRules.id, id)).limit(1);
    if (!row) throw notFound("Alert rule");
    return this.ruleDto(row);
  }

  private async validateRule(input: RuleInput): Promise<void> {
    if ((input.scopeType === "global") !== (input.scopeId === null)) throw badRequest("scopeId must be null for global rules and set otherwise");
    if (input.scopeType !== "global" && !(await this.rbac.scopeExists(input.scopeType, input.scopeId))) throw badRequest("Scope target does not exist");
    const meta = ALERT_RULE_KINDS[input.kind];
    if (meta.unit === "percent" && (input.threshold === null || input.threshold <= 0 || input.threshold > 100)) {
      throw badRequest(`${input.kind} needs a threshold between 0 and 100 (percent)`, validationDetails("must be a percentage between 0 and 100", "threshold"));
    }
    if (meta.unit === null && input.threshold !== null) {
      throw badRequest(`${input.kind} takes no threshold`, validationDetails("must be null for this rule kind", "threshold"));
    }
    // Node scope covers the node's servers; a server scope cannot cover a node.
    if (input.kind.startsWith("node.") && input.scopeType === "server") throw badRequest("Node rules cannot be scoped to a server");
    const unique = [...new Set(input.channelIds)];
    const found = await this.notifications.existingIds(unique);
    if (found.size !== unique.length) throw badRequest("Unknown notification channel");
  }

  async createRule(input: RuleInput, actor: AuditActor): Promise<AlertRule> {
    await this.validateRule(input);
    const id = randomUUID();
    const [row] = await withTransaction(this.db, async (tx) => {
      const r = await tx.insert(alertRules).values({ id, ...input, channelIds: [...new Set(input.channelIds)] }).returning();
      await this.audit.record({ ...actor, action: "alert_rule.create", targetType: "alert_rule", targetId: id, outcome: "success", details: { ...input } }, tx);
      return r;
    });
    if (!row) throw new Error("rule insert failed");
    return this.ruleDto(row);
  }

  async updateRule(id: string, input: RuleInput, actor: AuditActor): Promise<AlertRule> {
    await this.validateRule(input);
    const [row] = await withTransaction(this.db, async (tx) => {
      const r = await tx
        .update(alertRules)
        .set({ ...input, channelIds: [...new Set(input.channelIds)], updatedAt: new Date(this.clock.now()) })
        .where(eq(alertRules.id, id))
        .returning();
      if (r.length === 0) throw notFound("Alert rule");
      await this.audit.record({ ...actor, action: "alert_rule.update", targetType: "alert_rule", targetId: id, outcome: "success", details: { ...input } }, tx);
      return r;
    });
    if (!row) throw notFound("Alert rule");
    return this.ruleDto(row);
  }

  async deleteRule(id: string, actor: AuditActor): Promise<void> {
    await withTransaction(this.db, async (tx) => {
      const r = await tx.delete(alertRules).where(eq(alertRules.id, id)).returning({ name: alertRules.name });
      if (r.length === 0) throw notFound("Alert rule");
      await this.audit.record({ ...actor, action: "alert_rule.delete", targetType: "alert_rule", targetId: id, outcome: "success", details: { name: r[0]?.name } }, tx);
    });
  }

  // --- Incidents -----------------------------------------------------------------

  async incidentRow(id: string): Promise<IncidentRow> {
    const [row] = await this.db.select().from(alertIncidents).where(eq(alertIncidents.id, id)).limit(1);
    if (!row) throw notFound("Alert incident");
    return row;
  }

  /** The RBAC resource an incident's subject belongs to (jobs/unknown subjects are global). */
  async subjectResource(subjectType: string, subjectId: string): Promise<Resource> {
    if (subjectType === "node") return { type: "node", id: subjectId };
    if (subjectType === "server") return (await this.rbac.server(subjectId)) ?? { type: "global" };
    return { type: "global" };
  }

  async listIncidents(filter: {
    status?: string | undefined;
    severity?: string | undefined;
    limit: number;
    cursor: TimeIdCursor | null;
  }): Promise<{ rows: IncidentRow[]; next: TimeIdCursor | null }> {
    const conds: (SQL | undefined)[] = [];
    if (filter.severity) conds.push(eq(alertIncidents.severity, filter.severity));
    if (filter.status === "open") conds.push(ne(alertIncidents.status, "resolved"));
    else if (filter.status) conds.push(eq(alertIncidents.status, filter.status));
    if (filter.cursor) {
      const t = new Date(filter.cursor.t);
      conds.push(or(lt(alertIncidents.lastFiredAt, t), and(eq(alertIncidents.lastFiredAt, t), lt(alertIncidents.id, filter.cursor.id))));
    }
    const rows = await this.db
      .select()
      .from(alertIncidents)
      .where(and(...conds))
      .orderBy(desc(alertIncidents.lastFiredAt), desc(alertIncidents.id))
      .limit(filter.limit + 1);
    const page = rows.slice(0, filter.limit);
    const last = page[page.length - 1];
    return { rows: page, next: rows.length > filter.limit && last ? { t: last.lastFiredAt.getTime(), id: last.id } : null };
  }

  async acknowledge(id: string, actor: AuditActor): Promise<AlertIncident> {
    const row = await this.incidentRow(id);
    if (row.status !== "firing") throw invalidState(`Incident is ${row.status}`);
    const [updated] = await withTransaction(this.db, async (tx) => {
      const r = await tx
        .update(alertIncidents)
        .set({ status: "acknowledged", acknowledgedAt: new Date(this.clock.now()), acknowledgedBy: actor.actorId })
        .where(and(eq(alertIncidents.id, id), eq(alertIncidents.status, "firing")))
        .returning();
      await this.audit.record({ ...actor, action: "alert_incident.acknowledge", targetType: "alert_incident", targetId: id, outcome: "success" }, tx);
      return r;
    });
    if (!updated) throw invalidState("Incident changed concurrently");
    await this.publish(updated);
    const [dto] = await this.incidentDtos([updated]);
    return dto as AlertIncident;
  }

  async resolveManually(id: string, actor: AuditActor): Promise<AlertIncident> {
    const row = await this.incidentRow(id);
    if (row.status === "resolved") throw invalidState("Incident is already resolved");
    const updated = await this.resolveRow(row, actor.actorId, actor);
    const [dto] = await this.incidentDtos([updated]);
    return dto as AlertIncident;
  }

  /** Resolves an incident (manually or automatically), emits `alert.resolved` and notifies. */
  async resolveRow(row: IncidentRow, userId: string | null, actor?: AuditActor): Promise<IncidentRow> {
    const now = this.clock.now();
    const [updated] = await withTransaction(this.db, async (tx, after) => {
      const r = await tx
        .update(alertIncidents)
        .set({ status: "resolved", resolvedAt: new Date(now), resolvedBy: userId })
        .where(and(eq(alertIncidents.id, row.id), ne(alertIncidents.status, "resolved")))
        .returning();
      if (actor) await this.audit.record({ ...actor, action: "alert_incident.resolve", targetType: "alert_incident", targetId: row.id, outcome: "success" }, tx);
      await this.bus.publish(
        { type: "alert.resolved", subjectType: row.subjectType, subjectId: row.subjectId, data: { incidentId: row.id, kind: row.kind, manual: Boolean(actor) } },
        { tx, after },
      );
      return r;
    });
    if (!updated) throw invalidState("Incident changed concurrently");
    await this.publish(updated);
    if (updated.ruleId) {
      const [rule] = await this.db.select().from(alertRules).where(eq(alertRules.id, updated.ruleId)).limit(1);
      if (rule?.channelIds.length) {
        await this.notifications.notify(rule.channelIds, {
          status: "resolved",
          severity: updated.severity as "info" | "warning" | "critical",
          title: updated.summary,
          text: `${updated.subjectName ?? updated.subjectId}: resolved${actor ? ` by ${actor.actorName ?? "a user"}` : ""}.`,
          at: now,
          incidentId: updated.id,
        }, "resolved");
      }
    }
    return updated;
  }

  /** `alert.updated` on the `alerts` topic, filtered by alerts.view on the incident's subject. */
  async publish(row: IncidentRow): Promise<void> {
    if (!this.hub.hasSubscribers("alerts")) return;
    try {
      const [dto] = await this.incidentDtos([row]);
      this.hub.publish("alerts", "alert.updated", dto, { permission: "alerts.view", resource: await this.subjectResource(row.subjectType, row.subjectId) });
    } catch (err) {
      this.logger.debug({ err }, "alert.updated not published");
    }
  }
}
