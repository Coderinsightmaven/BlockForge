import { randomUUID } from "node:crypto";
import type { NotificationChannel as NotificationChannelSchema, NotificationTestResult } from "@blockforge/contracts";
import type { z } from "zod";
import { and, asc, eq, inArray, lte, sql } from "drizzle-orm";
import type { Logger } from "pino";
import type { AuditActor, AuditService } from "../audit/service.js";
import type { Db } from "../db/client.js";
import { alertRules, notificationChannels, notificationDeliveries } from "../db/schema/index.js";
import { withTransaction } from "../db/tx.js";
import type { Clock } from "../lib/clock.js";
import { badRequest, errorMessage, notFound, preconditionFailed } from "../lib/errors.js";
import type { SecretsService } from "../secrets/service.js";
import type { SettingsService } from "../settings/service.js";
import { EmailConfig, sendDiscord, sendWebhook, validateDiscordUrl, type EmailSender, type NotificationMessage } from "./adapters.js";
import type { RawPost } from "./http.js";
import { SsrfError, validateOutboundUrl, type LookupFn } from "./ssrf.js";

type ChannelRow = typeof notificationChannels.$inferSelect;
type NotificationChannel = z.infer<typeof NotificationChannelSchema>;
type ChannelKind = NotificationChannel["kind"];

export interface ChannelInput {
  name: string;
  kind: ChannelKind;
  enabled: boolean;
  config: Record<string, unknown>;
}

/** Backoff between delivery attempts (attempt n waits RETRY_DELAYS_MS[n-1]). */
const RETRY_DELAYS_MS = [30_000, 120_000, 600_000];

export interface NotificationDeps {
  db: Db;
  clock: Clock;
  secrets: SecretsService;
  settings: SettingsService;
  audit: AuditService;
  email: EmailSender;
  logger: Logger;
  /** Test seams for the SSRF-safe HTTP client. */
  lookup?: LookupFn;
  transport?: RawPost;
}

/**
 * Notification channels (Discord, generic webhook, email) and delivery attempts. Webhook URLs are
 * stored only in `secrets` (encrypted) and are never returned; `config` holds non-secret values.
 */
export class NotificationService {
  constructor(private readonly d: NotificationDeps) {}

  toDto(row: ChannelRow): NotificationChannel {
    return { id: row.id, name: row.name, kind: row.kind as ChannelKind, enabled: row.enabled, config: row.config, createdAt: row.createdAt.getTime() };
  }

  async list(): Promise<NotificationChannel[]> {
    const rows = await this.d.db.select().from(notificationChannels).orderBy(asc(notificationChannels.createdAt));
    return rows.map((r) => this.toDto(r));
  }

  async existingIds(ids: readonly string[]): Promise<Set<string>> {
    if (!ids.length) return new Set();
    const rows = await this.d.db.select({ id: notificationChannels.id }).from(notificationChannels).where(inArray(notificationChannels.id, [...ids]));
    return new Set(rows.map((r) => r.id));
  }

  /** Validates kind-specific config; returns the public config and the secret URL (if any). */
  private async validate(kind: ChannelKind, config: Record<string, unknown>, requireUrl: boolean): Promise<{ publicConfig: Record<string, unknown>; url: string | null }> {
    if (kind === "email") {
      if (!this.d.email.configured) throw preconditionFailed("Email notifications need SMTP_HOST/SMTP_FROM to be configured");
      const parsed = EmailConfig.safeParse(config);
      if (!parsed.success) throw badRequest("Email channels need config.to: a list of 1–20 email addresses");
      return { publicConfig: { to: parsed.data.to }, url: null };
    }
    const url = typeof config.url === "string" ? config.url.trim() : null;
    if (!url) {
      if (requireUrl) throw badRequest(`${kind} channels need config.url`);
      return { publicConfig: {}, url: null };
    }
    if (url.length > 2048) throw badRequest("URL too long");
    if (kind === "discord") {
      try {
        validateDiscordUrl(url);
      } catch (err) {
        throw badRequest(errorMessage(err));
      }
      return { publicConfig: {}, url };
    }
    try {
      const allowlist = await this.d.settings.get("notifications.webhookAllowlist");
      const target = await validateOutboundUrl(url, { allowlist, ...(this.d.lookup ? { lookup: this.d.lookup } : {}) });
      return { publicConfig: { host: target.url.hostname }, url };
    } catch (err) {
      if (err instanceof SsrfError) throw badRequest(`Webhook URL rejected: ${err.message}`);
      throw err;
    }
  }

  async create(input: ChannelInput, actor: AuditActor): Promise<NotificationChannel> {
    const { publicConfig, url } = await this.validate(input.kind, input.config, true);
    const id = randomUUID();
    const row = await withTransaction(this.d.db, async (tx) => {
      const secretId = url ? await this.d.secrets.create({ scopeType: "global", scopeId: null }, `notification-channel:${id}:url`, url, tx) : null;
      const [inserted] = await tx
        .insert(notificationChannels)
        .values({ id, name: input.name, kind: input.kind, enabled: input.enabled, config: publicConfig, secretId })
        .returning();
      await this.d.audit.record(
        { ...actor, action: "notification_channel.create", targetType: "notification_channel", targetId: id, outcome: "success", details: { name: input.name, kind: input.kind } },
        tx,
      );
      return inserted;
    });
    if (!row) throw new Error("channel insert failed");
    return this.toDto(row);
  }

  async update(id: string, input: ChannelInput, actor: AuditActor): Promise<NotificationChannel> {
    const [existing] = await this.d.db.select().from(notificationChannels).where(eq(notificationChannels.id, id)).limit(1);
    if (!existing) throw notFound("Notification channel");
    if (existing.kind !== input.kind) throw badRequest("The kind of a channel cannot be changed; create a new channel");
    const { publicConfig, url } = await this.validate(input.kind, input.config, false);
    const row = await withTransaction(this.d.db, async (tx) => {
      let secretId = existing.secretId;
      if (url) {
        if (secretId) await this.d.secrets.update(secretId, url, tx);
        else secretId = await this.d.secrets.create({ scopeType: "global", scopeId: null }, `notification-channel:${id}:url`, url, tx);
      }
      const keepConfig = input.kind !== "email" && !url ? existing.config : publicConfig;
      const [updated] = await tx
        .update(notificationChannels)
        .set({ name: input.name, enabled: input.enabled, config: keepConfig, secretId, updatedAt: new Date(this.d.clock.now()) })
        .where(eq(notificationChannels.id, id))
        .returning();
      await this.d.audit.record(
        { ...actor, action: "notification_channel.update", targetType: "notification_channel", targetId: id, outcome: "success", details: { name: input.name, urlChanged: Boolean(url) } },
        tx,
      );
      return updated;
    });
    if (!row) throw notFound("Notification channel");
    return this.toDto(row);
  }

  async remove(id: string, actor: AuditActor): Promise<void> {
    await withTransaction(this.d.db, async (tx) => {
      const [row] = await tx.delete(notificationChannels).where(eq(notificationChannels.id, id)).returning();
      if (!row) throw notFound("Notification channel");
      if (row.secretId) await this.d.secrets.delete(row.secretId, tx);
      await tx
        .update(alertRules)
        .set({ channelIds: sql`array_remove(${alertRules.channelIds}, ${id}::uuid)` })
        .where(sql`${id}::uuid = ANY(${alertRules.channelIds})`);
      await this.d.audit.record({ ...actor, action: "notification_channel.delete", targetType: "notification_channel", targetId: id, outcome: "success", details: { name: row.name } }, tx);
    });
  }

  /** Sends one message through a channel now. Throws with a safe (secret-free) message on failure. */
  private async send(channel: ChannelRow, message: NotificationMessage): Promise<void> {
    const opts = {
      allowlist: await this.d.settings.get("notifications.webhookAllowlist"),
      ...(this.d.lookup ? { lookup: this.d.lookup } : {}),
      ...(this.d.transport ? { transport: this.d.transport } : {}),
    };
    if (channel.kind === "email") {
      const cfg = EmailConfig.safeParse(channel.config);
      if (!cfg.success) throw new Error("email channel has no valid recipients");
      await this.d.email.send(cfg.data.to, message);
      return;
    }
    const url = channel.secretId ? await this.d.secrets.read(channel.secretId) : null;
    if (!url) throw new Error("channel URL is missing");
    if (channel.kind === "discord") await sendDiscord(url, message, opts);
    else await sendWebhook(url, message, opts);
  }

  async test(id: string, actor: AuditActor): Promise<NotificationTestResult> {
    const [channel] = await this.d.db.select().from(notificationChannels).where(eq(notificationChannels.id, id)).limit(1);
    if (!channel) throw notFound("Notification channel");
    const message: NotificationMessage = {
      status: "test",
      severity: "info",
      title: "Test notification",
      text: `This is a test message for the "${channel.name}" channel.`,
      at: this.d.clock.now(),
    };
    const deliveryId = randomUUID();
    await this.d.db.insert(notificationDeliveries).values({ id: deliveryId, channelId: id, reason: "test", status: "pending", payload: message, maxAttempts: 1 });
    const result = await this.attempt(deliveryId, channel, message, 1, 1);
    await this.d.audit.record({
      ...actor,
      action: "notification_channel.test",
      targetType: "notification_channel",
      targetId: id,
      outcome: result.delivered ? "success" : "failed",
      details: result.error ? { error: result.error } : {},
    });
    return result;
  }

  /** Queues a message for each enabled channel and attempts delivery right away (retries later). */
  async notify(channelIds: readonly string[], message: NotificationMessage, reason: "fired" | "resolved"): Promise<void> {
    if (!channelIds.length) return;
    const channels = await this.d.db
      .select()
      .from(notificationChannels)
      .where(and(inArray(notificationChannels.id, [...channelIds]), eq(notificationChannels.enabled, true)));
    for (const channel of channels) {
      const id = randomUUID();
      await this.d.db.insert(notificationDeliveries).values({
        id,
        channelId: channel.id,
        incidentId: message.incidentId ?? null,
        reason,
        status: "pending",
        payload: message,
        maxAttempts: RETRY_DELAYS_MS.length + 1,
        nextAttemptAt: new Date(this.d.clock.now()),
      });
      void this.attempt(id, channel, message, 1, RETRY_DELAYS_MS.length + 1);
    }
  }

  private async attempt(deliveryId: string, channel: ChannelRow, message: NotificationMessage, attempt: number, maxAttempts: number): Promise<NotificationTestResult> {
    const now = this.d.clock.now();
    try {
      await this.send(channel, message);
      await this.d.db
        .update(notificationDeliveries)
        .set({ status: "succeeded", attempts: attempt, lastAttemptAt: new Date(now), deliveredAt: new Date(this.d.clock.now()), nextAttemptAt: null, lastError: null })
        .where(eq(notificationDeliveries.id, deliveryId));
      return { delivered: true, error: null };
    } catch (err) {
      const error = errorMessage(err).slice(0, 500);
      const final = attempt >= maxAttempts;
      await this.d.db
        .update(notificationDeliveries)
        .set({
          status: final ? "failed" : "pending",
          attempts: attempt,
          lastAttemptAt: new Date(now),
          lastError: error,
          nextAttemptAt: final ? null : new Date(now + (RETRY_DELAYS_MS[attempt - 1] ?? 600_000)),
        })
        .where(eq(notificationDeliveries.id, deliveryId));
      if (final) this.d.logger.warn({ channelId: channel.id, deliveryId, error }, "notification delivery failed");
      return { delivered: false, error };
    }
  }

  /** Periodic retry of pending deliveries whose backoff elapsed. */
  async processPending(limit = 50): Promise<void> {
    const due = await this.d.db
      .select({ delivery: notificationDeliveries, channel: notificationChannels })
      .from(notificationDeliveries)
      .innerJoin(notificationChannels, eq(notificationChannels.id, notificationDeliveries.channelId))
      .where(and(eq(notificationDeliveries.status, "pending"), lte(notificationDeliveries.nextAttemptAt, new Date(this.d.clock.now()))))
      .orderBy(asc(notificationDeliveries.nextAttemptAt))
      .limit(limit);
    const now = this.d.clock.now();
    for (const { delivery, channel } of due) {
      // The first attempt is normally still in flight from notify(); pick it up only if it was lost.
      if (delivery.attempts === 0 && now - delivery.createdAt.getTime() < 60_000) continue;
      await this.attempt(delivery.id, channel, delivery.payload as NotificationMessage, delivery.attempts + 1, delivery.maxAttempts);
    }
  }
}
