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
import type { SecretsService } from "../secrets/service.js";
import type { SettingsService } from "../settings/service.js";

/** The S3 secret key lives in `secrets` (scope global); the setting itself never contains it. */
export const S3_SECRET_NAME = "backups.s3.secretAccessKey";
const GLOBAL_SCOPE = { scopeType: "global" as const, scopeId: null };

/** Stored form of `backups.storage` (no secret). */
export const StoredBackupStorage = z.discriminatedUnion("type", [
  z.object({ type: z.literal("local") }),
  BackupStorageSettings.options[1].omit({ secretAccessKey: true }),
]);
export type StoredBackupStorage = z.infer<typeof StoredBackupStorage>;
export type S3Config = Extract<StoredBackupStorage, { type: "s3" }> & { secretAccessKey: string };

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
  ) {}

  /** The settings as shown to admins (never the secret). */
  async view(): Promise<StoredBackupStorage & { secretAccessKeySet?: boolean }> {
    const stored = await this.settings.get("backups.storage");
    if (stored.type === "local") return stored;
    return { ...stored, secretAccessKeySet: Boolean(await this.secrets.findIdByName(GLOBAL_SCOPE, S3_SECRET_NAME)) };
  }

  async current(): Promise<{ type: "local" } | S3Config> {
    const stored = await this.settings.get("backups.storage");
    if (stored.type === "local") return stored;
    const id = await this.secrets.findIdByName(GLOBAL_SCOPE, S3_SECRET_NAME);
    const secretAccessKey = id ? await this.secrets.read(id) : null;
    if (!secretAccessKey) throw new StorageError("S3 backup storage is configured without a secret access key");
    return { ...stored, secretAccessKey };
  }

  /** Saves the settings; the secret is write-only (omitted = keep the stored one). */
  async save(value: BackupStorageSettings, userId: string | null): Promise<void> {
    if (value.type === "local") {
      await this.settings.set("backups.storage", { type: "local" }, userId);
      const id = await this.secrets.findIdByName(GLOBAL_SCOPE, S3_SECRET_NAME);
      if (id) await this.secrets.delete(id);
      return;
    }
    const { secretAccessKey, ...rest } = value;
    const id = await this.secrets.findIdByName(GLOBAL_SCOPE, S3_SECRET_NAME);
    if (secretAccessKey) {
      if (id) await this.secrets.update(id, secretAccessKey);
      else await this.secrets.create(GLOBAL_SCOPE, S3_SECRET_NAME, secretAccessKey);
    } else if (!id) {
      throw new StorageError("secretAccessKey is required the first time S3 storage is configured");
    }
    await this.settings.set("backups.storage", rest, userId);
  }

  /** Resolves a settings value for a test (falls back to the stored secret). */
  async resolveForTest(value: BackupStorageSettings | undefined): Promise<{ type: "local" } | S3Config> {
    if (!value) return this.current();
    if (value.type === "local") return value;
    if (value.secretAccessKey) return { ...value, secretAccessKey: value.secretAccessKey };
    const id = await this.secrets.findIdByName(GLOBAL_SCOPE, S3_SECRET_NAME);
    const stored = id ? await this.secrets.read(id) : null;
    if (!stored) throw new StorageError("no stored secret access key");
    return { ...value, secretAccessKey: stored };
  }

  client(cfg: S3Config): S3Client {
    return new S3Client({
      endpoint: cfg.endpoint,
      region: cfg.region,
      forcePathStyle: cfg.forcePathStyle,
      credentials: { accessKeyId: cfg.accessKeyId, secretAccessKey: cfg.secretAccessKey },
      maxAttempts: 3,
    });
  }

  objectKey(cfg: S3Config, serverId: string, backupId: string): string {
    return `${cfg.prefix}${serverId}/${backupId}.tar.gz`;
  }

  async startMultipart(cfg: S3Config, key: string, size: number): Promise<{ uploadId: string; partSize: number; parts: { partNumber: number; url: string }[] }> {
    const client = this.client(cfg);
    try {
      const created = await client.send(new CreateMultipartUploadCommand({ Bucket: cfg.bucket, Key: key, ContentType: "application/gzip" }));
      if (!created.UploadId) throw new StorageError("S3 did not return an upload id");
      const plan = partPlan(size);
      const parts: { partNumber: number; url: string }[] = [];
      for (let n = 1; n <= plan.count; n++) {
        const url = await getSignedUrl(client, new UploadPartCommand({ Bucket: cfg.bucket, Key: key, UploadId: created.UploadId, PartNumber: n }), {
          expiresIn: PRESIGN_TRANSFER_TTL_S,
        });
        parts.push({ partNumber: n, url });
      }
      return { uploadId: created.UploadId, partSize: plan.partSize, parts };
    } catch (err) {
      if (err instanceof StorageError) throw err;
      throw new StorageError(`starting the upload failed: ${s3Message(err)}`);
    } finally {
      client.destroy();
    }
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
