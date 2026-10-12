import { randomUUID } from "node:crypto";
import {
  AbortMultipartUploadCommand,
  CompleteMultipartUploadCommand,
  CreateMultipartUploadCommand,
  DeleteObjectCommand,
  GetObjectCommand,
  HeadBucketCommand,
  HeadObjectCommand,
  PutObjectCommand,
  S3Client,
  UploadPartCommand,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { BackupStorageSettings } from "@blockforge/contracts";
import { z } from "zod";
import { sql } from "drizzle-orm";
import type { Db } from "../db/client.js";
import type { S3StorageRef } from "../db/schema/index.js";
import type { SecretsService } from "../secrets/service.js";
import type { SettingsService } from "../settings/service.js";

/**
 * The S3 secret key lives in `secrets` (scope global), one row per version
 * (`backups.s3.secretAccessKey:<uuid>`; the pre-versioning row has no suffix). The setting stores the
 * current version's id; every S3 backup stores the location and secret id it was written with, and a
 * secret version is kept while any backup references it.
 */
export const S3_SECRET_NAME = "backups.s3.secretAccessKey";
const GLOBAL_SCOPE = { scopeType: "global" as const, scopeId: null };

/** Stored form of `backups.storage` (no secret; `secretId` = current secret version). */
export const StoredBackupStorage = z.discriminatedUnion("type", [
  z.object({ type: z.literal("local") }),
  BackupStorageSettings.options[1].omit({ secretAccessKey: true }).extend({ secretId: z.uuid().optional() }),
]);
export type StoredBackupStorage = z.infer<typeof StoredBackupStorage>;
type StoredS3 = Extract<StoredBackupStorage, { type: "s3" }>;
export type S3Config = Omit<StoredS3, "secretId"> & { secretAccessKey: string; secretId: string | null };
/** What the admin sees: no secret, no secret id. */
export type StorageView = { type: "local" } | (Omit<StoredS3, "secretId"> & { secretAccessKeySet: boolean });

export const MIN_PART_SIZE = 64 * 1024 ** 2;
const MAX_PARTS = 10_000;
/** Presigned part/restore URLs: long enough for a slow upload of a large archive. */
export const PRESIGN_TRANSFER_TTL_S = 6 * 3600;
/** Browser downloads (api.md: 5 minutes). */
export const PRESIGN_DOWNLOAD_TTL_S = 5 * 60;

/** Part size ≥ 64 MiB (MiB multiple) so that at most 10 000 parts cover `size`. */
export function partPlan(size: number): { partSize: number; count: number } {
  const mib = 1024 ** 2;
  const partSize = Math.max(MIN_PART_SIZE, Math.ceil(Math.ceil(size / MAX_PARTS) / mib) * mib);
  return { partSize, count: Math.max(1, Math.ceil(size / partSize)) };
}

export class StorageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "StorageError";
  }
}

/** S3 errors → short messages (never request details or credentials). */
function s3Message(err: unknown): string {
  const e = err as { name?: string; message?: string; $metadata?: { httpStatusCode?: number } };
  const status = e.$metadata?.httpStatusCode;
  return `${e.name ?? "S3Error"}${status ? ` (HTTP ${status})` : ""}: ${(e.message ?? "request failed").slice(0, 300)}`;
}

/**
 * Backup storage: local (archives stay on the node) or S3-compatible object storage. Credentials stay
 * in the control plane; agents only ever see presigned part/GET URLs.
 */
export class BackupStorage {
  constructor(
    private readonly settings: SettingsService,
    private readonly secrets: SecretsService,
    private readonly db: Db,
  ) {}

  private async stored(): Promise<StoredBackupStorage> {
    return (await this.settings.get("backups.storage")) as StoredBackupStorage;
  }

  /** Current secret version id (legacy un-versioned row as a fallback). */
  private async secretIdOf(s: StoredS3): Promise<string | null> {
    return s.secretId ?? (await this.secrets.findIdByName(GLOBAL_SCOPE, S3_SECRET_NAME));
  }

  /** The settings as shown to admins (never the secret or its id). */
  async view(): Promise<StorageView> {
    const s = await this.stored();
    if (s.type === "local") return { type: "local" };
    const { secretId: _id, ...rest } = s;
    const id = await this.secretIdOf(s);
    return { ...rest, secretAccessKeySet: Boolean(id && (await this.secrets.read(id))) };
  }

  async current(): Promise<{ type: "local" } | S3Config> {
    const s = await this.stored();
    if (s.type === "local") return { type: "local" };
    const id = await this.secretIdOf(s);
    const secretAccessKey = id ? await this.secrets.read(id) : null;
    if (!id || !secretAccessKey) throw new StorageError("S3 backup storage is configured without a secret access key");
    const { secretId: _sid, ...rest } = s;
    return { ...rest, secretAccessKey, secretId: id };
  }

  /** The immutable reference stored on a backup written with `cfg`. */
  refOf(cfg: S3Config): S3StorageRef {
    if (!cfg.secretId) throw new StorageError("the storage credentials have no id");
    return { endpoint: cfg.endpoint, region: cfg.region, bucket: cfg.bucket, prefix: cfg.prefix, forcePathStyle: cfg.forcePathStyle, accessKeyId: cfg.accessKeyId, secretId: cfg.secretId };
  }

  /** The configuration a backup was written with (independent of today's settings). */
  async fromRef(ref: S3StorageRef): Promise<S3Config> {
    const secretAccessKey = await this.secrets.read(ref.secretId);
    if (!secretAccessKey) throw new StorageError("the credentials of this backup's storage no longer exist");
    return { type: "s3", ...ref, secretAccessKey };
  }

  /** Deletes a secret version unless the settings or any backup still reference it. */
  async releaseSecret(secretId: string | null | undefined): Promise<void> {
    if (!secretId) return;
    const s = await this.stored();
    if (s.type === "s3" && (await this.secretIdOf(s)) === secretId) return;
    const used = await this.db.execute<{ n: number }>(sql`SELECT count(*)::int AS n FROM backups WHERE storage_ref->>'secretId' = ${secretId}`);
    if ((used.rows[0]?.n ?? 0) > 0) return;
    await this.secrets.delete(secretId);
  }

  /** Saves the settings; the secret is write-only (omitted = keep the stored one). A new secret is a new version. */
  async save(value: BackupStorageSettings, userId: string | null): Promise<void> {
    const before = await this.stored();
    const previous = before.type === "s3" ? await this.secretIdOf(before) : null;
    if (value.type === "local") {
      await this.settings.set("backups.storage", { type: "local" }, userId);
      await this.releaseSecret(previous);
      return;
    }
    const { secretAccessKey, ...rest } = value;
    let secretId = previous;
    if (secretAccessKey) {
      secretId = await this.secrets.create(GLOBAL_SCOPE, `${S3_SECRET_NAME}:${randomUUID()}`, secretAccessKey);
    } else if (!previous) {
      throw new StorageError("secretAccessKey is required the first time S3 storage is configured");
    }
    await this.settings.set("backups.storage", { ...rest, secretId: secretId! }, userId);
    if (previous && previous !== secretId) await this.releaseSecret(previous);
  }

  /** Resolves a settings value for a test (falls back to the stored secret). */
  async resolveForTest(value: BackupStorageSettings | undefined): Promise<{ type: "local" } | S3Config> {
    if (!value) return this.current();
    if (value.type === "local") return value;
    if (value.secretAccessKey) return { ...value, secretAccessKey: value.secretAccessKey, secretId: null };
    const cur = await this.current();
    if (cur.type !== "s3") throw new StorageError("no stored secret access key");
    return { ...value, secretAccessKey: cur.secretAccessKey, secretId: cur.secretId };
  }

  client(cfg: S3Config): S3Client {
    return new S3Client({
      endpoint: cfg.endpoint,
      region: cfg.region,
      forcePathStyle: cfg.forcePathStyle,
      credentials: { accessKeyId: cfg.accessKeyId, secretAccessKey: cfg.secretAccessKey },
      maxAttempts: 3,
      // Presigned part URLs are PUT by the agent as raw bytes: no SDK-added checksum parameters
      // (strict S3 implementations would reject parts without the announced checksum).
      requestChecksumCalculation: "WHEN_REQUIRED",
      responseChecksumValidation: "WHEN_REQUIRED",
    });
  }

  objectKey(cfg: Pick<S3Config, "prefix">, serverId: string, backupId: string): string {
    return `${cfg.prefix}${serverId}/${backupId}.tar.gz`;
  }

  async createMultipart(cfg: S3Config, key: string): Promise<string> {
    const client = this.client(cfg);
    try {
      const created = await client.send(new CreateMultipartUploadCommand({ Bucket: cfg.bucket, Key: key, ContentType: "application/gzip" }));
      if (!created.UploadId) throw new StorageError("S3 did not return an upload id");
      return created.UploadId;
    } catch (err) {
      if (err instanceof StorageError) throw err;
      throw new StorageError(`starting the upload failed: ${s3Message(err)}`);
    } finally {
      client.destroy();
    }
  }

  /** Presigned part URLs; the upload is aborted when presigning fails. */
  async presignParts(cfg: S3Config, key: string, uploadId: string, size: number): Promise<{ partSize: number; parts: { partNumber: number; url: string }[] }> {
    const client = this.client(cfg);
    try {
      const plan = partPlan(size);
      const parts: { partNumber: number; url: string }[] = [];
      for (let n = 1; n <= plan.count; n++) {
        const url = await getSignedUrl(client, new UploadPartCommand({ Bucket: cfg.bucket, Key: key, UploadId: uploadId, PartNumber: n }), { expiresIn: PRESIGN_TRANSFER_TTL_S });
        parts.push({ partNumber: n, url });
      }
      return { partSize: plan.partSize, parts };
    } catch (err) {
      await client.send(new AbortMultipartUploadCommand({ Bucket: cfg.bucket, Key: key, UploadId: uploadId })).catch(() => undefined);
      throw new StorageError(`presigning the upload failed: ${s3Message(err)}`);
    } finally {
      client.destroy();
    }
  }

  /** Create + presign (abort on any failure after the upload exists). */
  async startMultipart(cfg: S3Config, key: string, size: number): Promise<{ uploadId: string; partSize: number; parts: { partNumber: number; url: string }[] }> {
    const uploadId = await this.createMultipart(cfg, key);
    return { uploadId, ...(await this.presignParts(cfg, key, uploadId, size)) };
  }

  async completeMultipart(cfg: S3Config, key: string, uploadId: string, parts: { partNumber: number; etag: string }[]): Promise<void> {
    const client = this.client(cfg);
    try {
      await client.send(
        new CompleteMultipartUploadCommand({
          Bucket: cfg.bucket,
          Key: key,
          UploadId: uploadId,
          MultipartUpload: { Parts: [...parts].sort((a, b) => a.partNumber - b.partNumber).map((p) => ({ PartNumber: p.partNumber, ETag: p.etag })) },
        }),
      );
    } catch (err) {
      throw new StorageError(`completing the upload failed: ${s3Message(err)}`);
    } finally {
      client.destroy();
    }
  }

  async abortMultipart(cfg: S3Config, key: string, uploadId: string): Promise<void> {
    const client = this.client(cfg);
    try {
      await client.send(new AbortMultipartUploadCommand({ Bucket: cfg.bucket, Key: key, UploadId: uploadId }));
    } finally {
      client.destroy();
    }
  }

  /** Object size, or null when the object does not exist. */
  async objectSize(cfg: S3Config, key: string): Promise<number | null> {
    const client = this.client(cfg);
    try {
      const r = await client.send(new HeadObjectCommand({ Bucket: cfg.bucket, Key: key }));
      return r.ContentLength ?? 0;
    } catch (err) {
      if ((err as { $metadata?: { httpStatusCode?: number } }).$metadata?.httpStatusCode === 404) return null;
      throw new StorageError(`checking the object failed: ${s3Message(err)}`);
    } finally {
      client.destroy();
    }
  }

  async presignGet(cfg: S3Config, key: string, ttlSeconds: number, fileName?: string): Promise<string> {
    const client = this.client(cfg);
    try {
      return await getSignedUrl(
        client,
        new GetObjectCommand({ Bucket: cfg.bucket, Key: key, ...(fileName ? { ResponseContentDisposition: `attachment; filename="${fileName}"` } : {}) }),
        { expiresIn: ttlSeconds },
      );
    } finally {
      client.destroy();
    }
  }

  async deleteObject(cfg: S3Config, key: string): Promise<void> {
    const client = this.client(cfg);
    try {
      await client.send(new DeleteObjectCommand({ Bucket: cfg.bucket, Key: key }));
    } catch (err) {
      throw new StorageError(`deleting the object failed: ${s3Message(err)}`);
    } finally {
      client.destroy();
    }
  }

  /** HEAD bucket + put/delete a probe object. */
  async test(cfg: S3Config): Promise<{ ok: boolean; error: string | null }> {
    const client = this.client(cfg);
    const probe = `${cfg.prefix}.blockforge-probe-${randomUUID()}`;
    try {
      await client.send(new HeadBucketCommand({ Bucket: cfg.bucket }));
      await client.send(new PutObjectCommand({ Bucket: cfg.bucket, Key: probe, Body: "blockforge storage probe" }));
      await client.send(new DeleteObjectCommand({ Bucket: cfg.bucket, Key: probe }));
      return { ok: true, error: null };
    } catch (err) {
      return { ok: false, error: s3Message(err) };
    } finally {
      client.destroy();
    }
  }
}
