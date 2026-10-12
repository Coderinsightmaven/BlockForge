import { createHash, randomBytes, randomUUID } from "node:crypto";
import { Readable } from "node:stream";
import { afterEach, describe, expect, it } from "vitest";
import { TransferError } from "../../src/agents/transfers.js";
import type { ApiClient} from "../support/app.js";
import { startWithOwner, type TestApp } from "../support/app.js";
import { FakeAgent } from "../support/fake-agent.js";

let t: TestApp | null = null;
const agents: FakeAgent[] = [];
afterEach(async () => {
  for (const a of agents.splice(0)) await a.close().catch(() => undefined);
  await t?.close();
  t = null;
});

async function agent(t: TestApp, owner: ApiClient): Promise<FakeAgent> {
  const token = (await owner.post("/nodes/enrollment-tokens", { label: "t" })).json().secretToken;
  const a = new FakeAgent(t.baseUrl, t.wsBaseUrl);
  agents.push(a);
  expect((await a.enroll(token)).status).toBe(201);
  return a;
}

/** Deterministic pseudo-random chunks, so both ends can hash without holding the whole file. */
function chunks(count: number, size: number): { stream: () => Readable; sha256: string; bytes: number } {
  const parts = Array.from({ length: count }, (_, i) => createHash("sha256").update(String(i)).digest().subarray(0, 32));
  const make = (i: number) => Buffer.concat(Array.from({ length: size / 32 }, () => parts[i]!));
  const h = createHash("sha256");
  for (let i = 0; i < count; i++) h.update(make(i));
  return { stream: () => Readable.from((function* () { for (let i = 0; i < count; i++) yield make(i); })()), sha256: h.digest("hex"), bytes: count * size };
}

async function hashStream(s: Readable): Promise<{ sha256: string; bytes: number }> {
  const h = createHash("sha256");
  let bytes = 0;
  for await (const c of s) {
    h.update(c as Buffer);
    bytes += (c as Buffer).length;
  }
  return { sha256: h.digest("hex"), bytes };
}

describe("transfer rendezvous", () => {
  it("streams an agent upload to the waiting consumer (bound to the node)", async () => {
    let owner: ApiClient;
    ({ t, owner } = await startWithOwner());
    const a = await agent(t, owner);
    const b = await agent(t, owner);
    const file = chunks(160, 32 * 1024); // 5 MiB
    const id = randomUUID();
    const consumer = t.ctx.transfers.expectUpload({ id, nodeId: a.nodeId!, maxBytes: 10 * 1024 * 1024 });

    // Another node cannot claim it (indistinguishable from an unknown id).
    expect((await b.upload(id, Buffer.from("intruder"))).status).toBe(404);
    expect((await a.upload(id, Buffer.from("x"), "BFAgent garbage.sig")).status).toBe(401);

    const [upload, received] = await Promise.all([a.upload(id, file.stream()), consumer.then(hashStream)]);
    expect(upload).toEqual({ status: 200, json: { bytes: file.bytes } });
    expect(received).toEqual({ sha256: file.sha256, bytes: file.bytes });
    // Single use.
    expect((await a.upload(id, Buffer.from("again"))).status).toBe(404);
  });

  it("pipes without buffering: the consumer sees data before the upload finishes", async () => {
    let owner: ApiClient;
    ({ t, owner } = await startWithOwner());
    const a = await agent(t, owner);
    const id = randomUUID();
    const consumer = t.ctx.transfers.expectUpload({ id, nodeId: a.nodeId!, maxBytes: 1024 * 1024 });
    let release!: () => void;
    const firstChunkSeen = new Promise<void>((r) => (release = r));
    const body = Readable.from(
      (async function* () {
        yield Buffer.alloc(64 * 1024, 1);
        await firstChunkSeen; // would deadlock if the control plane buffered the whole body
        yield Buffer.alloc(64 * 1024, 2);
      })(),
    );
    const uploading = a.upload(id, body);
    const stream = await consumer;
    let total = 0;
    for await (const c of stream) {
      total += (c as Buffer).length;
      release();
    }
    expect(total).toBe(128 * 1024);
    expect((await uploading).status).toBe(200);
  });

  it("enforces the size limit", async () => {
    let owner: ApiClient;
    ({ t, owner } = await startWithOwner());
    const a = await agent(t, owner);
    const id = randomUUID();
    const consumer = t.ctx.transfers.expectUpload({ id, nodeId: a.nodeId!, maxBytes: 1000 });
    const result = consumer.then(hashStream).catch((err: unknown) => err);
    const res = await a.upload(id, randomBytes(64 * 1024)).catch((err: unknown) => ({ status: 0, json: String(err) }));
    expect([0, 413]).toContain(res.status);
    expect(await result).toBeInstanceOf(TransferError);
  });

  it("serves an offered stream to the agent and resolves with the byte count", async () => {
    let owner: ApiClient;
    ({ t, owner } = await startWithOwner());
    const a = await agent(t, owner);
    const b = await agent(t, owner);
    const file = chunks(96, 32 * 1024); // 3 MiB
    const id = randomUUID();
    const offered = t.ctx.transfers.offerDownload({ id, nodeId: a.nodeId!, maxBytes: file.bytes }, file.stream());
    expect((await b.download(id)).status).toBe(404);
    const res = await a.download(id);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("application/octet-stream");
    const got = await hashStream(Readable.fromWeb(res.body as never));
    expect(got).toEqual({ sha256: file.sha256, bytes: file.bytes });
    expect(await offered).toBe(file.bytes);
  });

  it("expires transfers whose agent never arrives", async () => {
    let owner: ApiClient;
    ({ t, owner } = await startWithOwner());
    const a = await agent(t, owner);
    const id = randomUUID();
    const offered = t.ctx.transfers.offerDownload({ id, nodeId: a.nodeId!, maxBytes: 10, timeoutMs: 150 }, Readable.from([Buffer.from("hi")]));
    await expect(offered).rejects.toMatchObject({ code: "TIMEOUT" });
    expect((await a.download(id)).status).toBe(404);
    expect(t.ctx.transfers.size).toBe(0);
  });
});
