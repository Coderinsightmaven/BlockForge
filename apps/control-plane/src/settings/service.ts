import { BackupStorageSettings } from "@blockforge/contracts";
import { eq } from "drizzle-orm";
import { z } from "zod";
import type { Db } from "../db/client.js";
import { settings } from "../db/schema/index.js";

/** Known settings and their schemas (unknown keys are rejected). */
export const SETTINGS = {
  /** Hostnames generic webhooks may reach even when they resolve to private/loopback addresses. */
  "notifications.webhookAllowlist": z.array(z.string().toLowerCase().regex(/^[a-z0-9.-]{1,253}$/)).max(100),
  /** Stored without the S3 secret (secrets table); managed by the dedicated `/settings/backups.storage` routes. */
  "backups.storage": z.discriminatedUnion("type", [z.object({ type: z.literal("local") }), BackupStorageSettings.options[1].omit({ secretAccessKey: true })]),
} as const;

/** Keys with dedicated routes (not writable through the generic `/settings/:key`). */
export const DEDICATED_SETTINGS: readonly SettingKey[] = ["backups.storage"];
export type SettingKey = keyof typeof SETTINGS;
export type SettingValue<K extends SettingKey> = z.infer<(typeof SETTINGS)[K]>;

const DEFAULTS: { [K in SettingKey]: SettingValue<K> } = {
  "notifications.webhookAllowlist": [],
  "backups.storage": { type: "local" },
};

export class SettingsService {
  constructor(private readonly db: Db) {}

  async get<K extends SettingKey>(key: K): Promise<SettingValue<K>> {
    const [row] = await this.db.select({ value: settings.value }).from(settings).where(eq(settings.key, key)).limit(1);
    if (!row) return DEFAULTS[key];
    const parsed = SETTINGS[key].safeParse(row.value);
    return parsed.success ? (parsed.data as SettingValue<K>) : DEFAULTS[key];
  }

  async set<K extends SettingKey>(key: K, value: SettingValue<K>, userId: string | null): Promise<void> {
    const parsed = SETTINGS[key].parse(value);
    await this.db
      .insert(settings)
      .values({ key, value: parsed, updatedBy: userId, updatedAt: new Date() })
      .onConflictDoUpdate({ target: settings.key, set: { value: parsed, updatedBy: userId, updatedAt: new Date() } });
  }
}
