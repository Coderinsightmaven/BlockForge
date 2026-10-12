import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import {
  AGENT_COMMANDS,
  AGENT_LIMITS,
  AGENT_PROTOCOL_VERSION,
  AgentWarningEvent,
  EventFrame,
  HeartbeatFrame,
  HelloFrame,
  LogsFrame,
  MetricsFrame,
  ProgressFrame,
  ResultErrFrame,
  ResultOkFrame,
  WorkloadOomEvent,
  WorkloadStateEvent,
  redactCommandPayload,
  type AgentCommandType,
  type CommandPayload,
  type CommandResult,
  type ControlPlaneFrame,
  type WorkloadStatus,
} from "@blockforge/contracts";
import { eq } from "drizzle-orm";
import type { Logger } from "pino";
import type { WebSocket } from "ws";
import type { z } from "zod";
import type { Db } from "../db/client.js";
import { agentCommands, type AgentCommandStatus } from "../db/schema/index.js";
import type { EventBus } from "../events/bus.js";
import { zodDetails } from "../http/errors.js";
import { toJsonSafe } from "../lib/canonical-json.js";
import type { Clock } from "../lib/clock.js";
import type { LatestCache } from "../metrics/latest.js";
import { encodeNodeSample, encodeWorkloadSample } from "../metrics/encode.js";
import type { VmWriter } from "../metrics/vm-writer.js";
import type { RealtimeHub } from "../realtime/hub.js";
import { buildSignedCommand } from "./commands.js";
import type { ConsoleBuffers } from "./console-buffer.js";
import type { NodeStateTracker } from "./node-state.js";
import type { ControlPlaneSigner } from "./signing-key.js";
import type { WorkloadOwnership } from "./workload-ownership.js";

export type ProgressUpdate = z.infer<typeof ProgressFrame>;

/** Error from a command dispatch: agent error codes plus gateway-side conditions. */
export class AgentCommandError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly retryable: boolean,
    readonly details?: unknown,
  ) {
    super(message);
    this.name = "AgentCommandError";
  }
}

export interface SendOptions {
  /** Time to wait for the result (default 30 s, max 15 min); also bounds the command's expiry. */
  timeoutMs?: number;
  jobId?: string | null;
  userId?: string | null;
  onProgress?: (p: ProgressUpdate) => void;
  signal?: AbortSignal;
  /** Pre-assigned command id (e.g. when the result must be bound to the id, as for key rotation). */
  commandId?: string;
}

/** WebSocket close codes used towards agents. */
export const CLOSE = {
  replaced: 4000,
  protocol: 4001,
  unsupportedProtocol: 4002,
  revoked: 4003,
  serviceRestart: 1012,
} as const;

const DEFAULT_COMMAND_TIMEOUT_MS = 30_000;
const HELLO_TIMEOUT_MS = 10_000;
const PING_INTERVAL_MS = 30_000;
const MAX_QUEUED_FRAMES = 1000;

interface PendingCommand {
  id: string;
  type: AgentCommandType;
  resolve: (value: unknown) => void;
  reject: (err: AgentCommandError) => void;
  timer: NodeJS.Timeout;
  onProgress?: (p: ProgressUpdate) => void;
  cleanup: () => void;
}

export class AgentSession {
  readonly id = randomUUID();
  ready = false;
  closed = false;
  replaced = false;
  agentVersion: string | null = null;
  capabilities: string[] = [];
  readonly pending = new Map<string, PendingCommand>();
  queueDepth = 0;
  queue: Promise<void> = Promise.resolve();
  alive = true;
  helloTimer: NodeJS.Timeout | null = null;
  pingTimer: NodeJS.Timeout | null = null;

  constructor(
    readonly nodeId: string,
    readonly socket: WebSocket,
    readonly ip: string | null,
    readonly connectedAt: number,
  ) {}

  sendFrame(frame: ControlPlaneFrame): void {
    if (this.closed || this.socket.readyState !== this.socket.OPEN) throw new Error("session closed");
    this.socket.send(JSON.stringify(frame));
  }

  close(code: number, reason: string): void {
    if (this.socket.readyState === this.socket.OPEN || this.socket.readyState === this.socket.CONNECTING) {
      this.socket.close(code, reason);
    }
  }
}

export interface GatewayStats {
  framesReceived: number;
  malformedFrames: number;
  unknownResults: number;
  droppedWorkloadFrames: number;
  droppedQueuedFrames: number;
}

export interface GatewayEvents {
  workloadState: [nodeId: string, status: WorkloadStatus];
  workloadOom: [nodeId: string, workloadId: string];
  sessionReady: [nodeId: string];
  sessionClosed: [nodeId: string];
  nodeMetrics: [nodeId: string];
}

export interface GatewayDeps {
  db: Db;
  clock: Clock;
  logger: Logger;
  signer: ControlPlaneSigner;
  latest: LatestCache;
  vm: VmWriter;
  hub: RealtimeHub;
  consoles: ConsoleBuffers;
  ownership: WorkloadOwnership;
  bus: EventBus;
  heartbeatIntervalMs: number;
  metricsIntervalMs: number;
}

/**
 * Holds one WebSocket session per node, validates every agent frame with the contracts schemas,
 * signs and dispatches commands, and routes telemetry (metrics → latest cache + VictoriaMetrics +
 * realtime; logs → console ring buffers; events → listeners). Malformed frames are counted and
 * logged; they never terminate a session.
 */
export class AgentGateway extends EventEmitter<GatewayEvents> {
  private readonly sessions = new Map<string, AgentSession>();
  private tracker!: NodeStateTracker;
  readonly stats: GatewayStats = {
    framesReceived: 0,
    malformedFrames: 0,
    unknownResults: 0,
    droppedWorkloadFrames: 0,
    droppedQueuedFrames: 0,
  };
  private lastMalformedLogAt = 0;

  constructor(private readonly deps: GatewayDeps) {
    super();
  }

  setTracker(tracker: NodeStateTracker): void {
    this.tracker = tracker;
  }

  isReady(nodeId: string): boolean {
    return this.sessions.get(nodeId)?.ready ?? false;
  }

  session(nodeId: string): AgentSession | undefined {
    return this.sessions.get(nodeId);
  }

  connectedNodeIds(): string[] {
    return [...this.sessions.values()].filter((s) => s.ready).map((s) => s.nodeId);
  }

  // --- Session lifecycle -------------------------------------------------------

  attach(nodeId: string, socket: WebSocket, ip: string | null): AgentSession {
    const session = new AgentSession(nodeId, socket, ip, this.deps.clock.now());
    const previous = this.sessions.get(nodeId);
    if (previous) {
      previous.replaced = true;
      this.failPending(previous, "session replaced by a newer connection");
      previous.close(CLOSE.replaced, "replaced by a newer session");
    }
    this.sessions.set(nodeId, session);

    session.helloTimer = setTimeout(() => {
      if (!session.ready) session.close(CLOSE.protocol, "hello not received");
    }, HELLO_TIMEOUT_MS);
    session.helloTimer.unref();
    session.pingTimer = setInterval(() => {
      if (!session.alive) {
        this.deps.logger.warn({ nodeId }, "agent socket unresponsive to ping; terminating");
        socket.terminate();
        return;
      }
      session.alive = false;
      try {
        socket.ping();
      } catch {
        /* closed */
      }
    }, PING_INTERVAL_MS);
    session.pingTimer.unref();

    socket.on("pong", () => {
      session.alive = true;
    });
    socket.on("message", (data, isBinary) => {
      session.alive = true;
      if (isBinary) {
        this.malformed(session, "binary frame");
        return;
      }
      if (session.queueDepth >= MAX_QUEUED_FRAMES) {
        this.stats.droppedQueuedFrames++;
        return;
      }
      session.queueDepth++;
      const text = Array.isArray(data) ? Buffer.concat(data).toString("utf8") : Buffer.from(data as ArrayBuffer).toString("utf8");
      session.queue = session.queue
        .then(() => this.handleFrame(session, text))
        .catch((err) => this.deps.logger.error({ err, nodeId }, "agent frame handling failed"))
        .finally(() => {
          session.queueDepth--;
        });
    });
    socket.on("close", (code) => void this.onClose(session, code));
    socket.on("error", (err) => this.deps.logger.warn({ err, nodeId }, "agent socket error"));
    this.deps.logger.info({ nodeId, ip }, "agent connected");
    return session;
  }

  private async onClose(session: AgentSession, code: number): Promise<void> {
    if (session.closed) return;
    session.closed = true;
    if (session.helloTimer) clearTimeout(session.helloTimer);
    if (session.pingTimer) clearInterval(session.pingTimer);
    this.failPending(session, "node disconnected");
    if (this.sessions.get(session.nodeId) === session) this.sessions.delete(session.nodeId);
    this.deps.logger.info({ nodeId: session.nodeId, code, replaced: session.replaced }, "agent disconnected");
    if (session.replaced) return;
    this.emit("sessionClosed", session.nodeId);
    await this.tracker.disconnected(session.nodeId, code === 1000 || code === 1001);
  }

  private failPending(session: AgentSession, reason: string): void {
    for (const p of [...session.pending.values()]) {
      p.cleanup();
      // Persist first so callers observing the rejection also see the recorded outcome.
      void this.persistOutcome(p.id, "failed", { code: "DISCONNECTED", message: reason, retryable: true }).finally(() =>
        p.reject(new AgentCommandError("NODE_UNAVAILABLE", reason, true)),
      );
    }
    session.pending.clear();
  }

  /** Closes the node's session (revocation, deletion). */
  disconnect(nodeId: string, code: number, reason: string): void {
    const s = this.sessions.get(nodeId);
    if (!s) return;
    this.failPending(s, reason);
    s.close(code, reason);
  }

  /** Re-sends `welcome` (e.g. after approval so the agent learns `approved: true`). */
  sendWelcome(nodeId: string, approved: boolean): void {
    const s = this.sessions.get(nodeId);
    if (!s?.ready) return;
    try {
      s.sendFrame(this.welcomeFrame(nodeId, approved));
    } catch (err) {
      this.deps.logger.debug({ err, nodeId }, "could not send welcome");
    }
  }

  private welcomeFrame(nodeId: string, approved: boolean): ControlPlaneFrame {
    return {
      t: "welcome",
      nodeId,
      serverTime: this.deps.clock.now(),
      approved,
      heartbeatIntervalMs: this.deps.heartbeatIntervalMs,
      metricsIntervalMs: this.deps.metricsIntervalMs,
    };
  }

  /** Graceful shutdown: tell agents to reconnect later. */
  closeAll(code: number = CLOSE.serviceRestart, reason = "control plane restarting"): void {
    for (const s of this.sessions.values()) {
      this.failPending(s, reason);
      s.close(code, reason);
    }
  }

  // --- Frames -------------------------------------------------------------------

  private malformed(session: AgentSession, reason: string, details?: unknown): void {
    this.stats.malformedFrames++;
    const now = this.deps.clock.now();
    if (now - this.lastMalformedLogAt > 10_000) {
      this.lastMalformedLogAt = now;
      this.deps.logger.warn({ nodeId: session.nodeId, reason, details, total: this.stats.malformedFrames }, "malformed agent frame ignored");
    }
  }

  private async handleFrame(session: AgentSession, text: string): Promise<void> {
    if (session.closed) return;
    this.stats.framesReceived++;
    let raw: unknown;
    try {
      raw = JSON.parse(text);
    } catch {
      this.malformed(session, "invalid JSON");
      return;
    }
    const t = typeof raw === "object" && raw !== null ? (raw as { t?: unknown }).t : undefined;
    if (t !== "hello" && !session.ready) {
      this.malformed(session, `frame "${String(t)}" before hello`);
      return;
    }
    switch (t) {
      case "hello":
        return this.onHello(session, this.validate(session, HelloFrame, raw));
      case "heartbeat":
        return this.onHeartbeat(session, this.validate(session, HeartbeatFrame, raw));
      case "progress":
        return this.onProgress(session, this.validate(session, ProgressFrame, raw));
      case "result":
        return this.onResult(session, raw);
      case "metrics":
        return this.onMetrics(session, this.validate(session, MetricsFrame, raw));
      case "event":
        return this.onEvent(session, this.validate(session, EventFrame, raw));
      case "logs":
        return this.onLogs(session, this.validate(session, LogsFrame, raw));
      default:
        this.malformed(session, `unknown frame type "${String(t)}"`);
    }
  }

  private validate<S extends z.ZodType>(session: AgentSession, schema: S, raw: unknown): z.infer<S> | null {
    const r = schema.safeParse(raw);
    if (!r.success) {
      this.malformed(session, `invalid ${String((raw as { t?: unknown }).t)} frame`, zodDetails(r.error));
      return null;
    }
    return r.data;
  }

  private async onHello(session: AgentSession, frame: z.infer<typeof HelloFrame> | null): Promise<void> {
    if (!frame) return;
    if (frame.protocolVersion !== AGENT_PROTOCOL_VERSION) {
      session.close(CLOSE.unsupportedProtocol, `unsupported protocol version ${frame.protocolVersion}`);
      return;
    }
    const firstHello = !session.ready;
    session.ready = true;
    session.agentVersion = frame.agentVersion;
    session.capabilities = frame.capabilities.slice(0, 64);
    if (session.helloTimer) clearTimeout(session.helloTimer);
    const skew = frame.ts - this.deps.clock.now();
    await this.tracker.connected(session.nodeId, {
      facts: frame.facts,
      agentVersion: frame.agentVersion,
      clockSkewMs: skew,
      ip: session.ip,
    });
    const owned = await this.deps.ownership.owned(session.nodeId, frame.workloads.map((w) => w.workloadId));
    for (const w of frame.workloads) if (owned.has(w.workloadId)) this.emit("workloadState", session.nodeId, w);
    const rt = this.tracker.get(session.nodeId);
    if (session.closed) return;
    session.sendFrame(this.welcomeFrame(session.nodeId, rt?.status !== "pending"));
    if (firstHello) this.emit("sessionReady", session.nodeId);
  }

  private async onHeartbeat(session: AgentSession, frame: z.infer<typeof HeartbeatFrame> | null): Promise<void> {
    if (!frame) return;
    await this.tracker.heartbeat(session.nodeId, frame.ts - this.deps.clock.now());
    await this.deps.bus.publish({
      type: "node.heartbeat.received",
      subjectType: "node",
      subjectId: session.nodeId,
      data: { uptimeMs: frame.uptimeMs },
    });
  }

  private onProgress(session: AgentSession, frame: ProgressUpdate | null): void {
    if (!frame) return;
    session.pending.get(frame.id)?.onProgress?.(frame);
  }

  private async onResult(session: AgentSession, raw: unknown): Promise<void> {
    const ok = (raw as { ok?: unknown }).ok === true;
    const frame = ok ? this.validate(session, ResultOkFrame, raw) : this.validate(session, ResultErrFrame, raw);
    if (!frame) return;
    const pending = session.pending.get(frame.id);
    if (!pending) {
      this.stats.unknownResults++;
      this.deps.logger.debug({ nodeId: session.nodeId, commandId: frame.id }, "result for unknown or timed-out command");
      return;
    }
    session.pending.delete(frame.id);
    pending.cleanup();
    if (frame.ok) {
      const parsed = AGENT_COMMANDS[pending.type].result.safeParse(frame.data);
      if (!parsed.success) {
        const error = { code: "VALIDATION_FAILED", message: "agent returned a result that does not match the contract", retryable: false };
        await this.persistOutcome(frame.id, "failed", error);
        pending.reject(new AgentCommandError(error.code, error.message, false, zodDetails(parsed.error)));
        return;
      }
      await this.persistOutcome(frame.id, "succeeded", null);
      pending.resolve(parsed.data);
    } else {
      const e = frame.error;
      await this.persistOutcome(frame.id, e.code === "COMMAND_REJECTED" ? "rejected" : "failed", toJsonSafe(e));
      pending.reject(new AgentCommandError(e.code, e.message, e.retryable, e.details));
    }
  }

  private async onMetrics(session: AgentSession, frame: z.infer<typeof MetricsFrame> | null): Promise<void> {
    if (!frame) return;
    const { nodeId } = session;
    const rt = this.tracker.get(nodeId);
    const skew = rt?.clockSkewMs ?? 0;
    const tsOffsetMs = Math.abs(skew) > 1000 ? -skew : 0;
    this.deps.latest.setNode(nodeId, frame.node);
    this.deps.vm.enqueue(
      encodeNodeSample(nodeId, frame.node, { tsOffsetMs, ...(rt?.facts ? { logicalCores: rt.facts.cpuLogicalCores } : {}) }),
    );
    const data = { nodeId, sample: frame.node };
    this.deps.hub.publish(`node:${nodeId}`, "node.metrics", data);
    this.deps.hub.publish("nodes", "node.metrics", data, { permission: "monitoring.view", resource: { type: "node", id: nodeId } });
    if (frame.workloads.length) {
      const owned = await this.deps.ownership.owned(nodeId, frame.workloads.map((w) => w.workloadId));
      for (const w of frame.workloads) {
        if (!owned.has(w.workloadId)) {
          this.stats.droppedWorkloadFrames++;
          continue;
        }
        this.deps.latest.setWorkload(w.workloadId, nodeId, w);
        this.deps.vm.enqueue(encodeWorkloadSample(w.workloadId, nodeId, w, { tsOffsetMs }));
        this.deps.hub.publish(`server:${w.workloadId}`, "server.metrics", { serverId: w.workloadId, sample: w });
      }
    }
    this.emit("nodeMetrics", nodeId);
  }

  private async onEvent(session: AgentSession, frame: z.infer<typeof EventFrame> | null): Promise<void> {
    if (!frame) return;
    const { nodeId } = session;
    switch (frame.event) {
      case "workload.state": {
        const s = WorkloadStateEvent.safeParse(frame.data);
        if (!s.success) return this.malformed(session, "invalid workload.state event", zodDetails(s.error));
        if (!(await this.deps.ownership.owned(nodeId, [s.data.workloadId])).has(s.data.workloadId)) {
          this.stats.droppedWorkloadFrames++;
          return;
        }
        this.emit("workloadState", nodeId, s.data);
        return;
      }
      case "workload.oom": {
        const s = WorkloadOomEvent.safeParse(frame.data);
        if (!s.success) return this.malformed(session, "invalid workload.oom event", zodDetails(s.error));
        if (!(await this.deps.ownership.owned(nodeId, [s.data.workloadId])).has(s.data.workloadId)) {
          this.stats.droppedWorkloadFrames++;
          return;
        }
        this.deps.logger.warn({ nodeId, workloadId: s.data.workloadId }, "workload killed by the OOM killer");
        this.emit("workloadOom", nodeId, s.data.workloadId);
        return;
      }
      case "agent.warning": {
        const s = AgentWarningEvent.safeParse(frame.data);
        if (!s.success) return this.malformed(session, "invalid agent.warning event", zodDetails(s.error));
        this.tracker.recordWarning(nodeId, s.data.code, s.data.message);
        this.deps.logger.warn({ nodeId, code: s.data.code, message: s.data.message.slice(0, 512) }, "agent warning");
        return;
      }
    }
  }

  private async onLogs(session: AgentSession, frame: z.infer<typeof LogsFrame> | null): Promise<void> {
    if (!frame) return;
    const serverId = frame.workloadId;
    if (!(await this.deps.ownership.owned(session.nodeId, [serverId])).has(serverId)) {
      this.stats.droppedWorkloadFrames++;
      return;
    }
    const lines = frame.lines.map((l) =>
      l.line.length > AGENT_LIMITS.logLineMaxBytes ? { ...l, line: l.line.slice(0, AGENT_LIMITS.logLineMaxBytes) } : l,
    );
    const appended = this.deps.consoles.append(serverId, lines, frame.dropped ?? 0);
    this.deps.hub.publish(`console:${serverId}`, "console.lines", {
      serverId,
      lines: appended,
      ...(frame.dropped ? { dropped: frame.dropped } : {}),
    });
  }

  // --- Commands -----------------------------------------------------------------

  private async persistOutcome(id: string, status: AgentCommandStatus, error: unknown): Promise<void> {
    try {
      await this.deps.db
        .update(agentCommands)
        .set({ status, error: error ?? null, completedAt: new Date(this.deps.clock.now()) })
        .where(eq(agentCommands.id, id));
    } catch (err) {
      this.deps.logger.error({ err, commandId: id }, "could not persist agent command outcome");
    }
  }

  /**
   * Signs and sends a command, then waits for its result. The payload is validated (and defaulted)
   * with the contracts schema, the result is validated against the result schema, and the command
   * is recorded in `agent_commands` (payload redacted). Rejects with `AgentCommandError`.
   */
  async send<T extends AgentCommandType>(
    nodeId: string,
    type: T,
    payload: CommandPayload<T>,
    opts: SendOptions = {},
  ): Promise<CommandResult<T>> {
    const rt = this.tracker.get(nodeId);
    if (!rt) throw new AgentCommandError("NOT_FOUND", "unknown node", false);
    if (rt.status === "revoked" || rt.status === "disabled") {
      throw new AgentCommandError("NODE_UNAVAILABLE", `node is ${rt.status}`, false);
    }
    if (rt.status === "pending" && type !== "node.facts") {
      throw new AgentCommandError("NODE_UNAVAILABLE", "node is awaiting approval; only node.facts is allowed", false);
    }
    const session = this.sessions.get(nodeId);
    if (!session?.ready) throw new AgentCommandError("NODE_UNAVAILABLE", "node is not connected", true);
    const parsed = AGENT_COMMANDS[type].payload.safeParse(payload);
    if (!parsed.success) {
      throw new AgentCommandError("VALIDATION_FAILED", "invalid command payload", false, zodDetails(parsed.error));
    }
    const timeoutMs = Math.max(1000, Math.min(opts.timeoutMs ?? DEFAULT_COMMAND_TIMEOUT_MS, AGENT_LIMITS.commandMaxLifetimeMs));
    const cmd = buildSignedCommand(this.deps.signer.privateKey, nodeId, type, parsed.data, this.deps.clock.now(), timeoutMs, opts.commandId);
    await this.deps.db.insert(agentCommands).values({
      id: cmd.id,
      nodeId,
      type,
      payloadRedacted: toJsonSafe(redactCommandPayload(type, parsed.data)) ?? {},
      issuedByUserId: opts.userId ?? null,
      jobId: opts.jobId ?? null,
      status: "sent",
      issuedAt: new Date(cmd.issuedAt),
      expiresAt: new Date(cmd.expiresAt),
    });
    if (opts.signal?.aborted) {
      await this.persistOutcome(cmd.id, "failed", { code: "CANCELLED", message: "cancelled before dispatch", retryable: false });
      throw new AgentCommandError("CANCELLED", "command cancelled", false);
    }

    return new Promise<CommandResult<T>>((resolve, reject) => {
      if (session.closed) {
        void this.persistOutcome(cmd.id, "failed", { code: "DISCONNECTED", message: "node disconnected", retryable: true });
        reject(new AgentCommandError("NODE_UNAVAILABLE", "node disconnected", true));
        return;
      }
      const onAbort = () => {
        if (!session.pending.delete(cmd.id)) return;
        pending.cleanup();
        void this.persistOutcome(cmd.id, "failed", { code: "CANCELLED", message: "cancelled", retryable: false }).finally(() =>
          reject(new AgentCommandError("CANCELLED", "command cancelled", false)),
        );
      };
      const timer = setTimeout(() => {
        if (!session.pending.delete(cmd.id)) return;
        pending.cleanup();
        void this.persistOutcome(cmd.id, "expired", { code: "TIMEOUT", message: `no result within ${timeoutMs} ms`, retryable: true }).finally(() =>
          reject(new AgentCommandError("TIMEOUT", `agent did not answer ${type} within ${timeoutMs} ms`, true)),
        );
      }, timeoutMs);
      const pending: PendingCommand = {
        id: cmd.id,
        type,
        resolve: resolve as (v: unknown) => void,
        reject,
        timer,
        ...(opts.onProgress ? { onProgress: opts.onProgress } : {}),
        cleanup: () => {
          clearTimeout(timer);
          opts.signal?.removeEventListener("abort", onAbort);
        },
      };
      opts.signal?.addEventListener("abort", onAbort, { once: true });
      session.pending.set(cmd.id, pending);
      try {
        session.sendFrame(cmd.frame);
      } catch {
        session.pending.delete(cmd.id);
        pending.cleanup();
        void this.persistOutcome(cmd.id, "failed", { code: "DISCONNECTED", message: "send failed", retryable: true });
        reject(new AgentCommandError("NODE_UNAVAILABLE", "node disconnected", true));
      }
    });
  }
}
