import { randomUUID } from "node:crypto";
import { ClientFrame, SESSION_COOKIE, type ServerFrame } from "@blockforge/contracts";
import type { FastifyInstance, FastifyRequest } from "fastify";
import type { WebSocket } from "ws";
import type { AppContext } from "../context.js";
import { errorBody } from "../http/errors.js";
import type { Principal } from "../rbac/authorize.js";
import type { RealtimeClient } from "./hub.js";
import { authorizeTopic } from "./topics.js";

/** Per-client outbound buffer cap; slower clients are disconnected (4008) and must reconnect. */
export const MAX_CLIENT_BUFFER_BYTES = 1024 * 1024;
const MAX_INBOUND_FRAME_BYTES = 16 * 1024;
const MAX_SUBSCRIPTIONS = 200;
const REVALIDATE_INTERVAL_MS = 30_000;
const PING_INTERVAL_MS = 30_000;

export const REALTIME_CLOSE = { slowConsumer: 4008, sessionEnded: 4001, frameTooLarge: 1009 } as const;

class SocketClient implements RealtimeClient {
  readonly id = randomUUID();
  readonly subscriptions = new Set<string>();
  closed = false;

  constructor(
    readonly userId: string,
    readonly sessionId: string,
    public principal: Principal,
    private readonly socket: WebSocket,
  ) {}

  close(code: number, reason: string): void {
    this.closed = true;
    this.socket.close(code, reason);
  }

  send(frame: ServerFrame): void {
    if (this.closed || this.socket.readyState !== this.socket.OPEN) return;
    const text = JSON.stringify(frame);
    if (this.socket.bufferedAmount + Buffer.byteLength(text) > MAX_CLIENT_BUFFER_BYTES) {
      this.closed = true;
      this.socket.close(REALTIME_CLOSE.slowConsumer, "client too slow; reconnect and re-read state");
      return;
    }
    this.socket.send(text);
  }
}

/**
 * UI realtime channel `GET /api/v1/realtime`. Runs inside the `/api/v1` scope, so the session
 * cookie, MFA gate and principal are resolved by the regular auth hooks *before* the upgrade; the
 * `Origin` header must equal PUBLIC_URL's origin (cross-site WebSocket hijacking protection).
 */
export function registerRealtimeRoutes(app: FastifyInstance, ctx: AppContext): void {
  app.get(
    "/realtime",
    {
      websocket: true,
      preValidation: async (req: FastifyRequest, reply) => {
        if (req.headers.origin !== ctx.config.publicOrigin) {
          return reply.status(403).send(errorBody(req, "FORBIDDEN", "Origin not allowed"));
        }
      },
    },
    (socket, req) => {
      const principal = req.principal;
      const session = req.session;
      const token = req.cookies[SESSION_COOKIE];
      if (!principal || !session || !token) {
        socket.close(REALTIME_CLOSE.sessionEnded, "unauthenticated");
        return;
      }
      const client = new SocketClient(session.user.id, session.id, principal, socket);
      ctx.hub.register(client);
      const reply = (frame: ServerFrame) => client.send(frame);
      let alive = true;

      const revalidate = setInterval(() => {
        void (async () => {
          const s = await ctx.sessions.lookup(token);
          if (!s || !s.mfaVerified) {
            socket.close(REALTIME_CLOSE.sessionEnded, "session ended");
            return;
          }
          const p = await ctx.rbac.loadPrincipal(s.user.id);
          if (!p) {
            socket.close(REALTIME_CLOSE.sessionEnded, "session ended");
            return;
          }
          client.principal = p;
          for (const topic of [...client.subscriptions]) {
            if (!(await authorizeTopic(topic, p, topicDeps(ctx)))) {
              ctx.hub.unsubscribe(client, topic);
              reply({ op: "unsubscribed", topic });
            }
          }
        })().catch((err) => ctx.logger.warn({ err }, "realtime revalidation failed"));
      }, REVALIDATE_INTERVAL_MS);
      revalidate.unref();
      const ping = setInterval(() => {
        if (!alive) {
          socket.terminate();
          return;
        }
        alive = false;
        socket.ping();
      }, PING_INTERVAL_MS);
      ping.unref();
      socket.on("pong", () => {
        alive = true;
      });

      socket.on("message", (data, isBinary) => {
        alive = true;
        const buf = Buffer.isBuffer(data) ? data : Array.isArray(data) ? Buffer.concat(data) : Buffer.from(data);
        if (isBinary || buf.length > MAX_INBOUND_FRAME_BYTES) {
          socket.close(REALTIME_CLOSE.frameTooLarge, "frame not accepted");
          return;
        }
        let raw: unknown;
        try {
          raw = JSON.parse(buf.toString("utf8"));
        } catch {
          reply({ op: "error", code: "INVALID_FRAME", message: "frames must be JSON" });
          return;
        }
        const parsed = ClientFrame.safeParse(raw);
        if (!parsed.success) {
          const topic = (raw as { topic?: unknown } | null)?.topic;
          reply({ op: "error", ...(typeof topic === "string" ? { topic: topic.slice(0, 64) } : {}), code: "INVALID_FRAME", message: "unknown operation or topic" });
          return;
        }
        const frame = parsed.data;
        if (frame.op === "ping") return reply({ op: "pong", ts: ctx.clock.now() });
        if (frame.op === "unsubscribe") {
          ctx.hub.unsubscribe(client, frame.topic);
          return reply({ op: "unsubscribed", topic: frame.topic });
        }
        void (async () => {
          if (client.subscriptions.has(frame.topic)) return reply({ op: "subscribed", topic: frame.topic });
          if (client.subscriptions.size >= MAX_SUBSCRIPTIONS) {
            return reply({ op: "error", topic: frame.topic, code: "TOO_MANY_SUBSCRIPTIONS", message: `at most ${MAX_SUBSCRIPTIONS} topics` });
          }
          if (!(await authorizeTopic(frame.topic, client.principal, topicDeps(ctx)))) {
            return reply({ op: "error", topic: frame.topic, code: "FORBIDDEN", message: "not allowed to subscribe to this topic" });
          }
          ctx.hub.subscribe(client, frame.topic);
          reply({ op: "subscribed", topic: frame.topic });
          if (frame.topic === "overview") {
            ctx.hub.sendTo(client, "overview", "overview.updated", await ctx.overview.summary(client.principal));
          }
        })().catch((err) => {
          ctx.logger.warn({ err }, "realtime subscribe failed");
          reply({ op: "error", topic: frame.topic, code: "INTERNAL", message: "subscription failed" });
        });
      });

      socket.on("close", () => {
        client.closed = true;
        clearInterval(revalidate);
        clearInterval(ping);
        ctx.hub.unregister(client);
      });
      socket.on("error", (err) => ctx.logger.debug({ err }, "realtime socket error"));
    },
  );
}

function topicDeps(ctx: AppContext) {
  return {
    rbac: ctx.rbac,
    jobTarget: async (jobId: string) => {
      const row = await ctx.jobs.getRow(jobId).catch(() => null);
      return row ? { targetType: row.targetType, targetId: row.targetId } : null;
    },
    serverPermissions: (principal: Principal, serverId: string) => ctx.serverAccess.permissionsOf(principal, serverId),
    hasPersonalServers: async (userId: string) => (await ctx.serverAccess.personalServerIds(userId, "servers.view")).length > 0,
  };
}
