import { z } from "zod";
import { Bytes, EpochMs, Id } from "../common.js";

/**
 * Server backups (Pterodactyl parity + Minecraft consistency).
 *
 * The agent writes `tar.gz` archives to `<dataRoot>/backups/<serverId>/<backupId>.tar.gz` (outside the
 * workload sandbox) and reports size + sha256. With S3 storage the control plane then has the agent
 * upload the archive through presigned multipart URLs (credentials never leave the control plane) and
 * deletes the local copy. Symlinks are not archived (counted in `skippedSymlinks`); restore rejects links.
 *
 * Consistency: for `minecraft-java` servers that are running, the control plane sends `save-off` +
 * `save-all flush`, waits for the save confirmation in the console, archives, then `save-on` (also on
 * failure). Other running servers are archived live unless the request asks to stop the server first.
 */
export const BackupStatus = z.enum(["pending", "running", "uploading", "completed", "failed"]);
export type BackupStatus = z.infer<typeof BackupStatus>;

export const BackupConsistency = z.enum(["live", "save-flush", "stopped"]);

export const Backup = z.object({
  id: Id,
  serverId: Id,
  name: z.string(),
  status: BackupStatus,
  /** Locked backups are never rotated or deleted until unlocked. */
  locked: z.boolean(),
  storage: z.enum(["local", "s3"]),
  consistency: BackupConsistency.nullable(),
  sizeBytes: Bytes.nullable(),
  sha256: z.string().nullable(),
  /** Patterns excluded from the archive (request + `.blockforgeignore`/`.pteroignore` in the data root). */
  ignored: z.array(z.string()),
  /** Symlinks and other special files (FIFOs, sockets, devices) that were not archived. */
  skippedSymlinks: z.number().int().nonnegative().nullable(),
  error: z.string().nullable(),
  /** User id of the creator (null for schedule-created or system backups). */
  createdBy: Id.nullable(),
  /** Display name of the creator at read time (username), or null. */
  createdByName: z.string().nullable(),
  /** Set when created by a schedule. */
  scheduleId: Id.nullable(),
  jobId: Id.nullable(),
  createdAt: EpochMs,
  completedAt: EpochMs.nullable(),
});
export type Backup = z.infer<typeof Backup>;

/**
 * Backup limit accounting: `pending`, `running`, `uploading` and `completed` backups count toward
 * `Server.backupLimit`; `failed` ones do not (they are kept for diagnosis and can be deleted).
 */
export const BACKUP_COUNTED_STATUSES = ["pending", "running", "uploading", "completed"] as const;

export const CreateBackupResponse = z.object({ backup: Backup, jobId: Id });
export const BackupStorageTestResult = z.object({ ok: z.boolean(), error: z.string().nullable() });

export const CreateBackupRequest = z.object({
  name: z.string().trim().max(120).optional(),
  /** gitignore-style patterns (same matcher as the file denylist). */
  ignore: z.array(z.string().max(512)).max(100).default([]),
  locked: z.boolean().default(false),
  /** Stop the server for the backup and start it again afterwards (exact snapshot, short downtime). */
  stopServer: z.boolean().default(false),
  /** When the server is at its backup limit, delete the oldest unlocked successful backup first. */
  rotate: z.boolean().default(false),
});

/** `PATCH /servers/:id/backups/:backupId` (servers.backups.delete). */
export const UpdateBackupRequest = z.object({
  name: z.string().trim().min(1).max(120).optional(),
  locked: z.boolean().optional(),
});

export const RestoreBackupRequest = z.object({
  /** Delete existing files before extracting (except `.blockforge/`). Default replaces only files in the archive. */
  truncate: z.boolean().default(false),
  /** Take a locked safety backup of the current state first (counts toward the limit; skipped at the limit). */
  safetyBackup: z.boolean().default(true),
  /** Start the server after a successful restore. */
  startAfter: z.boolean().default(true),
});

/** Admin settings (`settings.manage`): where completed backups live. Secret key is write-only. */
export const BackupStorageSettings = z.discriminatedUnion("type", [
  z.object({ type: z.literal("local") }),
  z.object({
    type: z.literal("s3"),
    endpoint: z.url({ protocol: /^https$/ }),
    region: z.string().min(1).max(64),
    bucket: z.string().min(3).max(63),
    prefix: z.string().max(256).default("blockforge/"),
    forcePathStyle: z.boolean().default(false),
    accessKeyId: z.string().min(1).max(128),
    /** Write-only; omitted on update keeps the stored secret. Never returned. */
    secretAccessKey: z.string().min(1).max(256).optional(),
  }),
]);
export type BackupStorageSettings = z.infer<typeof BackupStorageSettings>;
/** `GET /settings/backups.storage` → `{key, value}`; the S3 secret is never returned, only whether one is stored. */
export const BackupStorageSettingsView = z.object({
  key: z.literal("backups.storage"),
  /** Read shape: the S3 variant has no `secretAccessKey` field at all (strict — a response carrying it is rejected). */
  value: z.discriminatedUnion("type", [
    z.object({ type: z.literal("local") }).strict(),
    z
      .object({
        type: z.literal("s3"),
        endpoint: z.string(),
        region: z.string(),
        bucket: z.string(),
        prefix: z.string(),
        forcePathStyle: z.boolean(),
        accessKeyId: z.string(),
      })
      .strict(),
  ]),
  secretAccessKeySet: z.boolean(),
});
