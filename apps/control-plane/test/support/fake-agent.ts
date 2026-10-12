import { createPrivateKey, createPublicKey, generateKeyPairSync, randomBytes, sign, verify, type KeyObject } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Readable } from "node:stream";
import {
  AGENT_COMMANDS,
  AGENT_LIMITS,
  AGENT_TOKEN_AUDIENCE,
  CommandBody,
  ControlPlaneFrame,
  ROTATION_PROOF_PREFIX,
  type AgentCommandType,
  type EnrollResponse,
  type NodeFacts,
  type NodeMetricSample,
  type WorkloadMetricSample,
  type WorkloadStatus,
} from "@blockforge/contracts";
import WebSocket from "ws";

const FIXTURES = join(import.meta.dirname, "..", "..", "..", "..", "packages", "contracts", "fixtures", "agent");
export const loadFixture = <T = unknown>(name: string): T => JSON.parse(readFileSync(join(FIXTURES, name), "utf8")) as T;
export const FIXTURE_KEYS = loadFixture<{
  controlPlane: { seedHex: string; publicKey: string };
  agent: { seedHex: string; publicKey: string };
  nodeId: string;
  workloadId: string;
  now: number;
}>("keys.json");
export const FIXTURE_FACTS = loadFixture<{ facts: NodeFacts }>("hello.json").facts;

const SPKI = Buffer.from("302a300506032b6570032100", "hex");
const PKCS8 = Buffer.from("302e020100300506032b657004220420", "hex");

export function rawPublicKey(key: KeyObject): string {
  const der = createPublicKey(key).export({ format: "der", type: "spki" });
  return der.subarray(der.length - 32).toString("base64url");
}
export function publicKeyFromRaw(b64u: string): KeyObject {
  return createPublicKey({ key: Buffer.concat([SPKI, Buffer.from(b64u, "base64url")]), format: "der", type: "spki" });
}
export function privateKeyFromSeedHex(seedHex: string): KeyObject {
  return createPrivateKey({ key: Buffer.concat([PKCS8, Buffer.from(seedHex, "hex")]), format: "der", type: "pkcs8" });
}

/**
 * The agent-side command checks from packages/contracts/test/agent-fixtures.test.ts (mirrored by
 * the Go agent): signature over the exact body string → nodeId → expiry (+grace) → lifetime → payload.
 */
export function verifyCommandFrame(frame: unknown, cpPublicKey: string, nodeId: string, now: number): { result: string; body?: CommandBody } {
  const parsed = ControlPlaneFrame.parse(frame);
  if (parsed.t !== "cmd") throw new Error("not a command");
  const ok = verify(null, Buffer.from(parsed.body, "utf8"), publicKeyFromRaw(cpPublicKey), Buffer.from(parsed.sig, "base64url"));
  if (!ok) return { result: "bad-signature" };
  const body = CommandBody.parse(JSON.parse(parsed.body));
  if (body.nodeId !== nodeId) return { result: "wrong-node", body };
  if (now > body.expiresAt + AGENT_LIMITS.commandExpiryGraceMs) return { result: "expired", body };
  if (body.expiresAt - body.issuedAt > AGENT_LIMITS.commandMaxLifetimeMs) return { result: "lifetime", body };
  if (!AGENT_COMMANDS[body.type].payload.safeParse(body.payload).success) return { result: "invalid-payload", body };
  return { result: "ok", body };
}

export type CommandReply = { ok: true; data: unknown } | { ok: false; error: { code: string; message: string; retryable?: boolean } };
export type CommandHandler = (body: CommandBody, agent: FakeAgent) => Promise<CommandReply | null> | CommandReply | null;

interface Waiter {
  match: (f: Record<string, unknown>) => boolean;
  resolve: (f: Record<string, unknown>) => void;
}

/**
 * A scriptable stand-in for the Go node agent: enrolls with a real Ed25519 key, authenticates with
 * `BFAgent` tokens, speaks the WebSocket protocol, verifies every command signature with the pinned
 * control-plane key and answers commands through registered handlers.
 */
export class FakeAgent {
  privateKey: KeyObject;
  publicKey: string;
  nodeId: string | null = null;
  cpKey: string | null = null;
  ws: WebSocket | null = null;
  readonly frames: Record<string, unknown>[] = [];
  readonly commands: CommandBody[] = [];
  readonly rejectedCommands: string[] = [];
  readonly handlers = new Map<string, CommandHandler>();
  closeCode: number | null = null;
  private waiters: Waiter[] = [];

  constructor(
    readonly baseUrl: string,
    readonly wsBaseUrl: string,
    seedHex?: string,
  ) {
    this.privateKey = seedHex ? privateKeyFromSeedHex(seedHex) : generateKeyPairSync("ed25519").privateKey;
    this.publicKey = rawPublicKey(this.privateKey);
  }

  async enroll(token: string, opts: { facts?: NodeFacts; nodeName?: string } = {}): Promise<{ status: number; body: EnrollResponse & { error?: { code: string } } }> {
    const res = await fetch(`${this.baseUrl}/agent/v1/enroll`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        token,
        publicKey: this.publicKey,
        agentVersion: "0.1.0-test",
        protocolVersion: 1,
        facts: opts.facts ?? FIXTURE_FACTS,
        ...(opts.nodeName ? { nodeName: opts.nodeName } : {}),
      }),
    });
    const body = (await res.json()) as EnrollResponse & { error?: { code: string } };
    if (res.status === 201) {
      this.nodeId = body.nodeId;
      this.cpKey = body.controlPlaneSigningKey;
    }
    return { status: res.status, body };
  }

  /** `BFAgent <b64url(claims)>.<b64url(sig)>`; overrides allow crafting invalid tokens. */
  authHeader(o: { iat?: number; exp?: number; jti?: string; nid?: string; aud?: string; key?: KeyObject } = {}): string {
    const iat = o.iat ?? Date.now();
    const claims = {
      nid: o.nid ?? this.nodeId,
      aud: o.aud ?? AGENT_TOKEN_AUDIENCE,
      iat,
      exp: o.exp ?? iat + 60_000,
      jti: o.jti ?? randomBytes(18).toString("base64url"),
    };
    const seg = Buffer.from(JSON.stringify(claims)).toString("base64url");
    const sig = sign(null, Buffer.from(seg, "ascii"), o.key ?? this.privateKey).toString("base64url");
    return `BFAgent ${seg}.${sig}`;
  }

  /** Opens the WebSocket. Resolves on open; rejects with the HTTP status on a refused upgrade. */
  connect(header: string = this.authHeader()): Promise<void> {
    this.closeCode = null;
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(`${this.wsBaseUrl}/agent/v1/connect`, { headers: { authorization: header } });
      ws.on("open", () => {
        this.ws = ws;
        resolve();
      });
      ws.on("unexpected-response", (_req, res) => reject(Object.assign(new Error(`upgrade refused: ${res.statusCode}`), { status: res.statusCode })));
      ws.on("error", (err) => reject(err));
      ws.on("close", (code) => {
        this.closeCode = code;
        if (this.ws === ws) this.ws = null;
        this.notify({ t: "__closed", code });
      });
      ws.on("message", (data) => {
        const frame = JSON.parse(data.toString()) as Record<string, unknown>;
        this.frames.push(frame);
        if (frame.t === "cmd") void this.onCommand(frame);
        this.notify(frame);
      });
    });
  }

  private notify(frame: Record<string, unknown>): void {
    const matched = this.waiters.filter((w) => w.match(frame));
    this.waiters = this.waiters.filter((w) => !matched.includes(w));
    for (const w of matched) w.resolve(frame);
  }

  waitFor(match: (f: Record<string, unknown>) => boolean, timeoutMs = 5000): Promise<Record<string, unknown>> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("timed out waiting for frame")), timeoutMs);
      this.waiters.push({
        match,
        resolve: (f) => {
          clearTimeout(timer);
          resolve(f);
        },
      });
    });
  }

  waitForClose(timeoutMs = 5000): Promise<number> {
    if (!this.ws) return Promise.resolve(this.closeCode ?? 0);
    return this.waitFor((f) => f.t === "__closed", timeoutMs).then((f) => Number(f.code));
  }

  send(frame: Record<string, unknown>): void {
    if (!this.ws) throw new Error("not connected");
    this.ws.send(JSON.stringify(frame));
  }

  sendRaw(text: string): void {
    if (!this.ws) throw new Error("not connected");
    this.ws.send(text);
  }

  async hello(workloads: WorkloadStatus[] = [], facts: NodeFacts = FIXTURE_FACTS, ts = Date.now()): Promise<Record<string, unknown>> {
    const welcome = this.waitFor((f) => f.t === "welcome");
    this.send({ t: "hello", agentVersion: "0.1.0-test", protocolVersion: 1, ts, facts, capabilities: ["docker"], workloads });
    return welcome;
  }

  heartbeat(ts = Date.now()): void {
    this.send({ t: "heartbeat", ts, uptimeMs: 1000 });
  }

  metrics(node: NodeMetricSample, workloads: WorkloadMetricSample[] = []): void {
    this.send({ t: "metrics", ts: node.ts, node, workloads });
  }

  logs(workloadId: string, lines: { ts: number; stream: "stdout" | "stderr"; line: string }[], dropped?: number): void {
    this.send({ t: "logs", workloadId, lines, ...(dropped !== undefined ? { dropped } : {}) });
  }

  onCommandType(type: AgentCommandType, handler: CommandHandler): void {
    this.handlers.set(type, handler);
  }

  private async onCommand(frame: Record<string, unknown>): Promise<void> {
    if (!this.cpKey || !this.nodeId) throw new Error("fake agent not enrolled");
    const check = verifyCommandFrame(frame, this.cpKey, this.nodeId, Date.now());
    if (check.result !== "ok" || !check.body) {
      this.rejectedCommands.push(check.result);
      if (check.body) {
        this.send({ t: "result", id: check.body.id, ts: Date.now(), ok: false, error: { code: "COMMAND_REJECTED", message: check.result, retryable: false } });
      }
      return;
    }
    const body = check.body;
    this.commands.push(body);
    const handler = this.handlers.get(body.type);
    if (!handler) {
      this.send({ t: "result", id: body.id, ts: Date.now(), ok: false, error: { code: "UNSUPPORTED_COMMAND", message: `no handler for ${body.type}`, retryable: false } });
      return;
    }
    const reply = await handler(body, this);
    if (!reply) return;
    if (reply.ok) this.send({ t: "result", id: body.id, ts: Date.now(), ok: true, data: reply.data });
    else this.send({ t: "result", id: body.id, ts: Date.now(), ok: false, error: { retryable: false, ...reply.error } });
  }

  /**
   * Implements staged rotation (agent-protocol §3.1): answers `credentials.rotate` with a new key and
   * proof, closes the socket, reconnects with the new key and promotes it after `welcome`.
   */
  enableKeyRotation(): void {
    this.onCommandType("credentials.rotate", (body) => {
      const next = generateKeyPairSync("ed25519").privateKey;
      const proof = sign(null, Buffer.from(`${ROTATION_PROOF_PREFIX}${this.nodeId}:${body.id}`, "utf8"), next).toString("base64url");
      this.send({ t: "result", id: body.id, ts: Date.now(), ok: true, data: { publicKey: rawPublicKey(next), proof } });
      setTimeout(() => {
        void (async () => {
          this.ws?.close(1000, "rotating key");
          await new Promise((r) => setTimeout(r, 50));
          await this.connect(this.authHeader({ key: next }));
          await this.hello();
          this.privateKey = next;
          this.publicKey = rawPublicKey(next);
        })().catch((err) => this.notify({ t: "__rotation_failed", error: String(err) }));
      }, 20);
      return null;
    });
  }

  async upload(transferId: string, body: Readable | Buffer, header = this.authHeader()): Promise<{ status: number; json: unknown }> {
    const res = await fetch(`${this.baseUrl}/agent/v1/transfers/${transferId}`, {
      method: "POST",
      headers: { authorization: header, "content-type": "application/octet-stream" },
      body: (Buffer.isBuffer(body) ? body : Readable.toWeb(body)) as RequestInit["body"],
      // Node's fetch needs half-duplex for streaming request bodies.
      ...({ duplex: "half" } as object),
    });
    return { status: res.status, json: await res.json().catch(() => null) };
  }

  async download(transferId: string, header = this.authHeader()): Promise<Response> {
    return fetch(`${this.baseUrl}/agent/v1/transfers/${transferId}`, { headers: { authorization: header } });
  }

  async close(): Promise<void> {
    if (!this.ws) return;
    const closed = this.waitForClose();
    this.ws.close(1000, "bye");
    await closed.catch(() => undefined);
  }
}

/** A plausible node sample (values are test inputs, sent through the real ingest pipeline). */
export function nodeSample(ts: number, over: Partial<{ cpu: number; memUsedPct: number; fsUsedPct: number }> = {}): NodeMetricSample {
  const total = 64 * 1024 ** 3;
  const used = Math.round((total * (over.memUsedPct ?? 40)) / 100);
  const fsTotal = 1000 * 1024 ** 3;
  const fsUsed = Math.round((fsTotal * (over.fsUsedPct ?? 25)) / 100);
  return {
    ts,
    cpu: { usagePct: over.cpu ?? 37.5, perCorePct: [40, 35], load1: 1.5, load5: 1.2, load15: 1.0 },
    memory: { totalBytes: total, usedBytes: used, availableBytes: total - used },
    filesystems: [{ mount: "/", totalBytes: fsTotal, usedBytes: fsUsed, freeBytes: fsTotal - fsUsed }],
    diskIo: [{ device: "nvme0n1", readBytesPerSec: 1000, writeBytesPerSec: 2000, readOpsPerSec: 10, writeOpsPerSec: 20 }],
    network: [{ iface: "eth0", rxBytesPerSec: 5000, txBytesPerSec: 7000 }],
  };
}
