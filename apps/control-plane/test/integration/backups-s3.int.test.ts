import { randomUUID } from "node:crypto";
import { CreateBucketCommand, HeadObjectCommand, ListMultipartUploadsCommand, ListObjectsV2Command, S3Client } from "@aws-sdk/client-s3";
import { Backup, TransferUrlResponse } from "@blockforge/contracts";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { responseLog, startWithOwner, type ApiClient, type TestApp } from "../support/app.js";
import { testPool } from "../support/db.js";
import { TEST_S3 } from "../support/env.js";
import type { FakeAgent } from "../support/fake-agent.js";
import { catalogOptions, connectSimNode, paperRequest, templateIdByKey, waitJob } from "../support/panel.js";

/** S3 backups against the dev MinIO (infra/compose, HTTPS with a self-signed certificate). */

let t: TestApp | null = null;
const agents: FakeAgent[] = [];
afterEach(async () => {
  for (const a of agents.splice(0)) await a.close().catch(() => undefined);
  await t?.close();
  t = null;
});

const s3 = new S3Client({ endpoint: TEST_S3.endpoint, region: TEST_S3.region, forcePathStyle: true, credentials: { accessKeyId: TEST_S3.accessKeyId, secretAccessKey: TEST_S3.secretAccessKey } });
let bucket = "";
beforeAll(async () => {
  bucket = `bf-test-${randomUUID().slice(0, 8)}`;
  await s3.send(new CreateBucketCommand({ Bucket: bucket }));
});

const settings = (over: Record<string, unknown> = {}) => ({
  type: "s3",
  endpoint: TEST_S3.endpoint,
  region: TEST_S3.region,
  bucket,
  prefix: "blockforge/",
  forcePathStyle: true,
  accessKeyId: TEST_S3.accessKeyId,
  secretAccessKey: TEST_S3.secretAccessKey,
  ...over,
});

async function objects(prefix: string): Promise<{ key: string; size: number }[]> {
  const r = await s3.send(new ListObjectsV2Command({ Bucket: bucket, Prefix: prefix }));
  return (r.Contents ?? []).map((o) => ({ key: o.Key!, size: o.Size ?? 0 }));
}

const list = async (c: ApiClient, id: string) => ((await c.get(`/servers/${id}/backups`)).json() as unknown[]).map((b) => Backup.parse(b));

describe("backup storage settings", () => {
  it("stores the S3 secret write-only, tests connectivity and never returns the secret", async () => {
    const r = await startWithOwner();
    t = r.t;
    const owner = r.owner;
    expect((await owner.get("/settings/backups.storage")).json()).toEqual({ key: "backups.storage", value: { type: "local" }, secretAccessKeySet: false });
    // The secret is required the first time.
    const { secretAccessKey: _omit, ...noSecret } = settings();
    expect((await owner.put("/settings/backups.storage", { value: noSecret })).statusCode).toBe(400);
    const saved = await owner.put("/settings/backups.storage", { value: settings() });
    expect(saved.statusCode, saved.body).toBe(200);
    expect(saved.json()).toMatchObject({ key: "backups.storage", value: { type: "s3", bucket }, secretAccessKeySet: true });
    expect(saved.json().value).not.toHaveProperty("secretAccessKeySet");
    expect(JSON.stringify(saved.json())).not.toContain("secretAccessKey\"");
    expect(saved.body).not.toContain(TEST_S3.secretAccessKey);
    // Updating without the secret keeps it; the generic settings route does not expose the key.
    expect((await owner.put("/settings/backups.storage", { value: { ...noSecret, prefix: "bf/" } })).json()).toMatchObject({ value: { prefix: "bf/" }, secretAccessKeySet: true });
    expect((await owner.get("/settings/backups.storage")).body).not.toContain(TEST_S3.secretAccessKey);
    expect((await owner.put("/settings/backups.storage.x", { value: 1 })).statusCode).toBe(404);
    const { rows: secretRows } = await testPool().query("SELECT ciphertext FROM secrets WHERE name LIKE 'backups.s3.secretAccessKey%'");
    expect(secretRows).toHaveLength(1);
    expect(Buffer.from(secretRows[0].ciphertext).toString("utf8")).not.toContain(TEST_S3.secretAccessKey);
    const { rows: audit } = await testPool().query("SELECT details FROM audit_events WHERE target_id = 'backups.storage'");
    expect(JSON.stringify(audit)).not.toContain(TEST_S3.secretAccessKey);
    // Connectivity test: stored settings, and candidate settings with wrong credentials.
    expect((await owner.post("/settings/backups.storage/test")).json()).toEqual({ ok: true, error: null });
    const bad = (await owner.post("/settings/backups.storage/test", { value: settings({ secretAccessKey: "wrong-secret-key" }) })).json();
    expect(bad.ok).toBe(false);
    expect(bad.error).toMatch(/SignatureDoesNotMatch|InvalidAccessKeyId|Forbidden|403/);
    expect(responseLog.every((x) => !x.body.includes(TEST_S3.secretAccessKey))).toBe(true);
  });
});

describe("S3 backups", () => {
  it("uploads with presigned multipart parts, verifies, downloads via presigned GET, restores, deletes", async () => {
    const cat = catalogOptions();
    const r = await startWithOwner({ background: true, catalog: cat.catalog, serverJobs: { readyTimeoutMs: 10_000, slpWaitMs: 0, saveTimeoutMs: 1500 } });
    t = r.t;
    const owner = r.owner;
    expect((await owner.put("/settings/backups.storage", { value: settings() })).statusCode).toBe(200);
    const node = await connectSimNode(r.t, owner, { agents });
    const created = await owner.post("/servers", paperRequest(await templateIdByKey(owner, "minecraft-java"), { startup: "manual" }));
    const id = created.json().server.id as string;
    await waitJob(owner, created.json().jobId);
    node.sim.put(id, "world/level.dat", "s3-v1");

    const b = await owner.post(`/servers/${id}/backups`, { name: "s3" });
    const job = await waitJob(owner, b.json().jobId);
    expect(job.status, JSON.stringify(job)).toBe("succeeded");
    const [backup] = await list(owner, id);
    expect(backup).toMatchObject({ storage: "s3", status: "completed", consistency: "stopped" });
    const key = `blockforge/${id}/${backup!.id}.tar.gz`;
    const head = await s3.send(new HeadObjectCommand({ Bucket: bucket, Key: key }));
    expect(head.ContentLength).toBe(backup!.sizeBytes);
    // The local copy is removed after the verified upload; presigned URLs never reach the job log.
    expect(node.sim.backupArchives.has(`${id}:${backup!.id}`)).toBe(false);
    const logs = JSON.stringify((await owner.get(`/jobs/${b.json().jobId}/logs`)).json());
    expect(logs).not.toContain("X-Amz-Signature");
    const { rows: cmds } = await testPool().query("SELECT payload_redacted FROM agent_commands WHERE type IN ('backup.upload', 'backup.restore')");
    expect(JSON.stringify(cmds)).not.toContain("X-Amz-Signature");

    // Download: a presigned GET valid for 5 minutes.
    const dl = TransferUrlResponse.parse((await owner.get(`/servers/${id}/backups/${backup!.id}/download`)).json());
    expect(dl.url.startsWith(`${TEST_S3.endpoint}/${bucket}/${key}?`)).toBe(true);
    expect(dl.expiresAt - Date.now()).toBeLessThanOrEqual(5 * 60_000);
    const fetched = await fetch(dl.url);
    expect(fetched.status).toBe(200);
    const bytes = Buffer.from(await fetched.arrayBuffer());
    expect(bytes.length).toBe(backup!.sizeBytes);
    expect(JSON.parse(bytes.toString("utf8"))["world/level.dat"]).toBe("s3-v1");

    // Restore downloads the object (presigned GET) and verifies the sha256.
    node.sim.put(id, "world/level.dat", "changed");
    const restore = await owner.post(`/servers/${id}/backups/${backup!.id}/restore`, { safetyBackup: true, startAfter: false });
    const rj = await waitJob(owner, restore.json().jobId);
    expect(rj.status, JSON.stringify(rj)).toBe("succeeded");
    expect(node.sim.read(id, "world/level.dat")).toBe("s3-v1");
    const safety = (await list(owner, id)).find((x) => x.name.startsWith("Safety"))!;
    expect(safety).toMatchObject({ storage: "s3", status: "completed", locked: true });
    expect((await objects(`blockforge/${id}/`)).map((o) => o.key).sort()).toEqual([key, `blockforge/${id}/${safety.id}.tar.gz`].sort());

    // Delete removes the object.
    const del = await owner.delete(`/servers/${id}/backups/${backup!.id}`);
    expect((await waitJob(owner, del.json().jobId)).status).toBe("succeeded");
    expect((await objects(key)).length).toBe(0);

    // A failed upload aborts the multipart upload (no orphaned parts) and fails the backup.
    node.sim.options = { fail: { "backup.upload": { code: "RUNTIME_ERROR", message: "connection reset" } } };
    const failing = await owner.post(`/servers/${id}/backups`, { name: "broken" });
    const fj = await waitJob(owner, failing.json().jobId);
    expect(fj.status).toBe("failed");
    expect((await list(owner, id)).find((x) => x.name === "broken")).toMatchObject({ status: "failed" });
    const uploads = await s3.send(new ListMultipartUploadsCommand({ Bucket: bucket, Prefix: `blockforge/${id}/` }));
    expect(uploads.Uploads ?? []).toEqual([]);
    node.sim.options = {};

    // Deleting the server deletes its objects (the locked safety backup too).
    const delServer = await owner.delete(`/servers/${id}`);
    expect((await waitJob(owner, delServer.json().jobId)).status).toBe("succeeded");
    expect(await objects(`blockforge/${id}/`)).toEqual([]);
  });
});
