import type { Readable } from "node:stream";
import { EnrollRequest } from "@blockforge/contracts";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import type { AppContext } from "../context.js";
import { errorBody } from "../http/errors.js";
import { parse } from "../http/validation.js";
import { AppError, notFound, validationDetails } from "../lib/errors.js";
import type { AuthenticatedAgent } from "./authenticator.js";
import { AgentAuthError } from "./token.js";
import { TransferError } from "./transfers.js";

declare module "fastify" {
  interface FastifyRequest {
    agent: AuthenticatedAgent | null;
  }
}

const TransferParams = z.object({ id: z.uuid() });

/**
 * `/agent/v1/*`: agent-authenticated endpoints (no cookies, no CSRF). Authentication runs in
 * `onRequest`, before any body is read or the WebSocket upgrade happens.
 */
export function registerAgentRoutes(app: FastifyInstance, ctx: AppContext): void {
  app.decorateRequest("agent", null);
  // Transfer bodies are streamed straight through; never buffered or parsed.
  app.addContentTypeParser("application/octet-stream", (_req, payload, done) => done(null, payload));

  const authenticate = async (req: FastifyRequest) => {
    try {
      req.agent = await ctx.authenticator.authenticate(req.headers.authorization);
    } catch (err) {
      if (err instanceof AgentAuthError) {
        req.log.info({ reason: err.reason }, "agent authentication rejected");
        throw new AppError(401, "UNAUTHENTICATED", "Invalid agent credentials");
      }
      throw err;
    }
  };

  app.post("/enroll", { config: { rateLimit: { max: 20, timeWindow: "1 minute" } } }, async (req, reply) => {
    const body = parse(EnrollRequest, req.body);
    const res = await ctx.enrollment.enroll(body, req.ip ?? null);
    reply.status(201);
    return res;
  });

  app.get("/connect", { websocket: true, onRequest: authenticate }, (socket, req) => {
    const agent = req.agent;
    if (!agent) {
      socket.close(1008, "unauthenticated");
      return;
    }
    ctx.gateway.attach(agent.nodeId, socket, req.ip ?? null);
  });

  app.post("/transfers/:id", { onRequest: authenticate, bodyLimit: Number.MAX_SAFE_INTEGER }, async (req, reply) => {
    const { id } = parse(TransferParams, req.params, "Path");
    const agent = req.agent;
    if (!agent) throw new AppError(401, "UNAUTHENTICATED", "Invalid agent credentials");
    const body = req.body as Readable | undefined;
    if (!body || typeof (body as Readable).pipe !== "function") {
      throw new AppError(415, "VALIDATION_FAILED", "Transfers must be sent as application/octet-stream", validationDetails("content-type must be application/octet-stream"));
    }
    try {
      const bytes = await ctx.transfers.acceptAgentUpload(id, agent.nodeId, body);
      return reply.status(200).send({ bytes });
    } catch (err) {
      throw transferHttpError(err);
    }
  });

  app.get("/transfers/:id", { onRequest: authenticate }, async (req, reply) => {
    const { id } = parse(TransferParams, req.params, "Path");
    const agent = req.agent;
    if (!agent) throw new AppError(401, "UNAUTHENTICATED", "Invalid agent credentials");
    let stream: Readable;
    try {
      stream = ctx.transfers.openAgentDownload(id, agent.nodeId);
    } catch (err) {
      throw transferHttpError(err);
    }
    reply.header("content-type", "application/octet-stream");
    return reply.send(stream);
  });

  app.setNotFoundHandler((req, reply) => {
    reply.status(404).send(errorBody(req, "NOT_FOUND", "Unknown agent endpoint"));
  });
}

function transferHttpError(err: unknown): unknown {
  if (!(err instanceof TransferError)) return err;
  switch (err.code) {
    case "NOT_FOUND":
      return notFound("Transfer");
    case "TOO_LARGE":
      return new AppError(413, "VALIDATION_FAILED", err.message, validationDetails(err.message));
    case "TIMEOUT":
      return new AppError(408, "PRECONDITION_FAILED", err.message);
    default:
      return new AppError(409, "CONFLICT", err.message);
  }
}
