import { randomUUID } from "node:crypto";
import { and, desc, eq, gt, ne } from "drizzle-orm";
import type { Logger } from "pino";
import type { NodeStateTracker } from "../agents/node-state.js";
import type { Db } from "../db/client.js";
import { alertIncidents, alertRules, servers } from "../db/schema/index.js";
import type { DomainEvent, EventBus } from "../events/bus.js";
import type { Clock } from "../lib/clock.js";
import type { LatestCache } from "../metrics/latest.js";
import type { NotificationService } from "../notifications/service.js";
import type { AlertService } from "./service.js";

type RuleRow = typeof alertRules.$inferSelect;
type IncidentRow = typeof alertIncidents.$inferSelect;

/** A condition evaluated for one subject; `value` null = no data (neither fires nor resolves). */
export interface Observation {
  dedupKey: string;
  subjectType: string;
  subjectId: string;
  subjectName: string | null;
  summary: string;
  value: number | null;
  firing: boolean | null;
}

/** Node statuses that are monitored (maintenance/disabled/pending/revoked nodes are silenced). */
const MONITORED_NODE_STATUSES = new Set(["active", "draining"]);

const pct = (part: number, whole: number) => (whole > 0 ? (part / whole) * 100 : null);

/**
 * Evaluates state-based rules every ALERT_EVAL_INTERVAL_MS from the in-memory latest cache and node
 * state, and event-based rules (job.failed, server.crashed) from domain events.
 *  - `forSeconds`: the condition must hold continuously that long (tracked in memory).
 *  - dedup: one open incident per (rule, subject); repeats update it and bump `occurrences`.
 *  - cooldown: a subject that re-fires within `cooldownSeconds` of resolving re-opens the previous
 *    incident and is not re-notified until the cooldown since the last notification has passed.
 *  - auto-resolve: when the condition clears; a manual resolve suppresses re-firing until it clears.
 */
export class AlertEvaluator {
  private readonly pendingSince = new Map<string, number>();
  private readonly suppressed = new Set<string>();

  constructor(
    private readonly db: Db,
    private readonly clock: Clock,
    private readonly tracker: NodeStateTracker,
    private readonly latest: LatestCache,
    private readonly alerts: AlertService,
    private readonly notifications: NotificationService,
    private readonly bus: EventBus,
    private readonly logger: Logger,
  ) {}

  subscribe(): void {
    this.bus.subscribe("job.updated", (e) => this.onJobUpdated(e));
    this.bus.subscribe("server.crashed", (e) => this.onServerCrashed(e));
    this.bus.subscribe("alert.resolved", (e) => {
      if (e.data.manual) void this.onManualResolve(String(e.data.incidentId ?? ""));
    });
  }

  private async onManualResolve(incidentId: string): Promise<void> {
    const [row] = await this.db.select({ key: alertIncidents.dedupKey }).from(alertIncidents).where(eq(alertIncidents.id, incidentId));
    if (row) this.suppressed.add(row.key);
  }

  // --- State-based rules ---------------------------------------------------------

  async evaluate(): Promise<void> {
    const rules = await this.db.select().from(alertRules).where(eq(alertRules.enabled, true));
    const stateRules = rules.filter((r) => r.kind !== "job.failed" && r.kind !== "server.crashed");
    if (stateRules.length === 0) return;
    const open = await this.db.select().from(alertIncidents).where(ne(alertIncidents.status, "resolved"));
    const openByKey = new Map(open.map((i) => [i.dedupKey, i]));
    const seen = new Set<string>();
    const serverRows = stateRules.some((r) => r.kind.startsWith("server."))
      ? await this.db.select({ id: servers.id, name: servers.name, nodeId: servers.nodeId }).from(servers)
      : [];
    for (const rule of stateRules) {
      for (const obs of this.observe(rule, serverRows)) {
        seen.add(obs.dedupKey);
        await this.apply(rule, obs, openByKey.get(obs.dedupKey) ?? null);
      }
    }
    // Subjects that disappeared (node deleted, rule rescoped, mount gone): resolve their incidents.
    for (const inc of open) {
      if (seen.has(inc.dedupKey) || !inc.ruleId) continue;
      const rule = stateRules.find((r) => r.id === inc.ruleId);
      if (!rule) continue;
      this.pendingSince.delete(inc.dedupKey);
      await this.alerts.resolveRow(inc, null).catch((err) => this.logger.warn({ err }, "auto-resolve failed"));
    }
  }

  private inScope(rule: RuleRow, nodeId: string, serverId?: string): boolean {
    if (rule.scopeType === "global") return true;
    if (rule.scopeType === "node") return rule.scopeId === nodeId;
    return serverId !== undefined && rule.scopeId === serverId;
  }

  observe(rule: RuleRow, serverRows: { id: string; name: string; nodeId: string }[]): Observation[] {
    const out: Observation[] = [];
    const threshold = rule.threshold ?? (rule.kind === "node.disk.low" ? 10 : 90);
    if (rule.kind.startsWith("node.")) {
      for (const n of this.tracker.all()) {
        if (!MONITORED_NODE_STATUSES.has(n.status) || !this.inScope(rule, n.id)) continue;
        const key = `${rule.id}:node:${n.id}`;
        const base = { subjectType: "node", subjectId: n.id, subjectName: n.name };
        if (rule.kind === "node.unreachable") {
          out.push({ ...base, dedupKey: key, summary: `Node ${n.name} is unreachable`, value: null, firing: n.connection === "unreachable" });
          continue;
        }
        const sample = this.latest.getNode(n.id);
        if (rule.kind === "node.cpu.high") {
          const v = sample?.cpu.usagePct ?? null;
          out.push({ ...base, dedupKey: key, summary: `CPU on ${n.name} above ${threshold}%`, value: v, firing: v === null ? null : v > threshold });
        } else if (rule.kind === "node.memory.high") {
          const v = sample ? pct(sample.memory.totalBytes - sample.memory.availableBytes, sample.memory.totalBytes) : null;
          out.push({ ...base, dedupKey: key, summary: `Memory on ${n.name} above ${threshold}%`, value: v, firing: v === null ? null : v > threshold });
        } else if (rule.kind === "node.disk.low") {
          // ALERT_RULE_KINDS: fires when FREE space is below the threshold percentage.
          if (!sample) continue;
          for (const fs of sample.filesystems) {
            const free = pct(fs.freeBytes, fs.totalBytes);
            if (free === null) continue;
            out.push({
              ...base,
              subjectName: `${n.name} ${fs.mount}`,
              dedupKey: `${key}:${fs.mount}`,
              summary: `Filesystem ${fs.mount} on ${n.name} has ${free.toFixed(1)}% free (threshold ${threshold}%)`,
              value: free,
              firing: free < threshold,
            });
          }
        }
      }
    } else if (rule.kind === "server.memory.high" || rule.kind === "server.heap.high") {
      for (const s of serverRows) {
        const n = this.tracker.get(s.nodeId);
        if (!n || !MONITORED_NODE_STATUSES.has(n.status) || !this.inScope(rule, s.nodeId, s.id)) continue;
        const w = this.latest.getWorkload(s.id);
        const v =
          rule.kind === "server.memory.high"
            ? w?.memoryUsageBytes !== undefined && w.memoryLimitBytes
              ? pct(w.memoryUsageBytes, w.memoryLimitBytes)
              : null
            : w?.jvm
              ? pct(w.jvm.heapUsedBytes, w.jvm.heapMaxBytes)
              : null;
        out.push({
          dedupKey: `${rule.id}:server:${s.id}`,
          subjectType: "server",
          subjectId: s.id,
          subjectName: s.name,
          summary: `${rule.kind === "server.memory.high" ? "Memory" : "JVM heap"} of ${s.name} above ${threshold}%`,
          value: v,
          firing: v === null ? null : v > threshold,
        });
      }
    }
    return out;
  }

  private async apply(rule: RuleRow, obs: Observation, open: IncidentRow | null): Promise<void> {
    const now = this.clock.now();
    if (obs.firing === null) {
      this.pendingSince.delete(obs.dedupKey);
      return;
    }
    if (!obs.firing) {
      this.pendingSince.delete(obs.dedupKey);
      this.suppressed.delete(obs.dedupKey);
      if (open) await this.alerts.resolveRow(open, null);
      return;
    }
    const since = this.pendingSince.get(obs.dedupKey) ?? now;
    this.pendingSince.set(obs.dedupKey, since);
    if (now - since < rule.forSeconds * 1000) return;
    if (this.suppressed.has(obs.dedupKey)) return;
    if (open) {
      if (obs.value !== open.value || now - open.lastFiredAt.getTime() > 60_000) {
        const [updated] = await this.db
          .update(alertIncidents)
          .set({ value: obs.value, lastFiredAt: new Date(now), summary: obs.summary })
          .where(eq(alertIncidents.id, open.id))
          .returning();
        if (updated) await this.alerts.publish(updated);
      }
      return;
    }
    await this.fire(rule, obs, false);
  }

  /** Opens (or re-opens within cooldown / bumps for event rules) an incident and notifies. */
  async fire(rule: RuleRow, obs: Observation, eventBased: boolean): Promise<IncidentRow | null> {
    const now = this.clock.now();
    const cooldownMs = rule.cooldownSeconds * 1000;
    const [open] = await this.db
      .select()
      .from(alertIncidents)
      .where(and(eq(alertIncidents.dedupKey, obs.dedupKey), ne(alertIncidents.status, "resolved")))
      .limit(1);
    let row: IncidentRow | undefined;
    let notify: boolean;
    let reopened = false;
    if (open) {
      if (!eventBased) return open;
      [row] = await this.db
        .update(alertIncidents)
        .set({ occurrences: open.occurrences + 1, lastFiredAt: new Date(now), value: obs.value, summary: obs.summary })
        .where(eq(alertIncidents.id, open.id))
        .returning();
      notify = !open.lastNotifiedAt || now - open.lastNotifiedAt.getTime() >= cooldownMs;
    } else {
      const [recent] = await this.db
        .select()
        .from(alertIncidents)
        .where(and(eq(alertIncidents.dedupKey, obs.dedupKey), eq(alertIncidents.status, "resolved"), gt(alertIncidents.resolvedAt, new Date(now - cooldownMs))))
        .orderBy(desc(alertIncidents.resolvedAt))
        .limit(1);
      if (recent) {
        reopened = true;
        [row] = await this.db
          .update(alertIncidents)
          .set({ status: "firing", occurrences: recent.occurrences + 1, lastFiredAt: new Date(now), value: obs.value, summary: obs.summary, resolvedAt: null, resolvedBy: null, acknowledgedAt: null, acknowledgedBy: null })
          .where(eq(alertIncidents.id, recent.id))
          .returning();
        notify = !recent.lastNotifiedAt || now - recent.lastNotifiedAt.getTime() >= cooldownMs;
      } else {
        [row] = await this.db
          .insert(alertIncidents)
          .values({
            id: randomUUID(),
            ruleId: rule.id,
            dedupKey: obs.dedupKey,
            kind: rule.kind,
            severity: rule.severity,
            status: "firing",
            subjectType: obs.subjectType,
            subjectId: obs.subjectId,
            subjectName: obs.subjectName,
            summary: obs.summary,
            value: obs.value,
            firstFiredAt: new Date(now),
            lastFiredAt: new Date(now),
          })
          .onConflictDoNothing()
          .returning();
        notify = true;
      }
    }
    if (!row) return null;
    if (!open) {
      await this.bus.publish({
        type: "alert.fired",
        subjectType: row.subjectType,
        subjectId: row.subjectId,
        data: { incidentId: row.id, kind: row.kind, severity: row.severity, reopened },
      });
    }
    if (notify && rule.channelIds.length) {
      await this.db.update(alertIncidents).set({ lastNotifiedAt: new Date(now) }).where(eq(alertIncidents.id, row.id));
      await this.notifications.notify(
        rule.channelIds,
        {
          status: "firing",
          severity: rule.severity as "info" | "warning" | "critical",
          title: obs.summary,
          text: `${obs.subjectName ?? obs.subjectId}: ${obs.summary}${obs.value !== null ? ` (value ${obs.value.toFixed(1)})` : ""}`,
          at: now,
          incidentId: row.id,
          fields: [
            { name: "Rule", value: rule.name },
            { name: "Severity", value: rule.severity },
          ],
        },
        "fired",
      );
    }
    await this.alerts.publish(row);
    return row;
  }

  // --- Event-based rules ---------------------------------------------------------

  private async eventRules(kind: string): Promise<RuleRow[]> {
    return this.db.select().from(alertRules).where(and(eq(alertRules.enabled, true), eq(alertRules.kind, kind)));
  }

  private async onJobUpdated(e: DomainEvent): Promise<void> {
    if (e.data.status !== "failed") return;
    const jobId = String(e.data.jobId ?? e.subjectId ?? "");
    const type = String(e.data.type ?? "job");
    const targetType = typeof e.data.targetType === "string" ? e.data.targetType : null;
    const targetId = typeof e.data.targetId === "string" ? e.data.targetId : null;
    const message = typeof (e.data.error as { message?: unknown } | null)?.message === "string" ? (e.data.error as { message: string }).message : "failed";
    const subjectName = targetType === "node" && targetId ? (this.tracker.get(targetId)?.name ?? null) : null;
    for (const rule of await this.eventRules("job.failed")) {
      if (rule.scopeType !== "global") {
        const nodeOfTarget =
          targetType === "node" ? targetId : targetType === "server" && targetId ? await this.serverNode(targetId) : null;
        if (rule.scopeType === "node" && rule.scopeId !== nodeOfTarget) continue;
        if (rule.scopeType === "server" && !(targetType === "server" && rule.scopeId === targetId)) continue;
      }
      await this.fire(
        rule,
        {
          dedupKey: `${rule.id}:job:${type}:${targetType ?? "none"}:${targetId ?? jobId}`,
          subjectType: targetType ?? "job",
          subjectId: targetId ?? jobId,
          subjectName,
          summary: `Job ${type} failed: ${message.slice(0, 300)}`,
          value: null,
          firing: true,
        },
        true,
      );
    }
  }

  private async onServerCrashed(e: DomainEvent): Promise<void> {
    const serverId = e.subjectId;
    if (!serverId) return;
    const [s] = await this.db.select({ name: servers.name, nodeId: servers.nodeId }).from(servers).where(eq(servers.id, serverId));
    if (!s) return;
    for (const rule of await this.eventRules("server.crashed")) {
      if (!this.inScope(rule, s.nodeId, serverId)) continue;
      const exitCode = typeof e.data.exitCode === "number" ? e.data.exitCode : null;
      await this.fire(
        rule,
        {
          dedupKey: `${rule.id}:server:${serverId}`,
          subjectType: "server",
          subjectId: serverId,
          subjectName: s.name,
          summary: `Server ${s.name} crashed${exitCode !== null ? ` (exit code ${exitCode})` : ""}`,
          value: exitCode,
          firing: true,
        },
        true,
      );
    }
  }

  private async serverNode(serverId: string): Promise<string | null> {
    const [r] = await this.db.select({ nodeId: servers.nodeId }).from(servers).where(eq(servers.id, serverId));
    return r?.nodeId ?? null;
  }
}
