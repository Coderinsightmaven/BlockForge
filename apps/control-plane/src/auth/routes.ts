import {
  ChangePasswordRequest,
  LoginRequest,
  MfaEnrollConfirm,
  MfaVerifyRequest,
  SetupRequest,
  type LoginResponse,
} from "@blockforge/contracts";
import type { FastifyInstance } from "fastify";
import type { z } from "zod";
import type { AppContext } from "../context.js";
import { actorOf, clearSessionCookies, clientOf, requireSession, setSessionCookies } from "../http/auth-hooks.js";
import { parse } from "../http/validation.js";
import { AppError } from "../lib/errors.js";

const LOGIN_RATE = { max: 20, timeWindow: "1 minute" };
const SETUP_RATE = { max: 10, timeWindow: "1 minute" };
const MFA_RATE = { max: 20, timeWindow: "1 minute" };

export function registerAuthRoutes(app: FastifyInstance, ctx: AppContext): void {
  const secure = ctx.config.cookieSecure;

  app.get("/auth/setup", { config: { auth: "public" } }, async () => ({ setupRequired: await ctx.auth.isSetupRequired() }));

  app.post("/auth/setup", { config: { auth: "public", csrf: false, rateLimit: SETUP_RATE } }, async (req, reply) => {
    const body = parse(SetupRequest, req.body);
    if (!(await ctx.auth.isSetupRequired())) throw new AppError(409, "SETUP_ALREADY_COMPLETED", "Setup has already been completed");
    const created = await ctx.auth.completeSetup(body, clientOf(req));
    setSessionCookies(reply, created, secure);
    reply.status(201);
    return ctx.auth.me(created.session);
  });

  app.post("/auth/login", { config: { auth: "public", csrf: false, rateLimit: LOGIN_RATE } }, async (req, reply) => {
    const body = parse(LoginRequest, req.body);
    if (await ctx.auth.isSetupRequired()) throw new AppError(409, "SETUP_REQUIRED", "Complete the first-run setup first");
    const result = await ctx.auth.login(body.email, body.password, clientOf(req));
    setSessionCookies(reply, result.created, secure);
    const response: z.infer<typeof LoginResponse> =
      result.status === "ok" ? { status: "ok", me: await ctx.auth.me(result.created.session) } : { status: "mfa_required" };
    return response;
  });

  app.post("/auth/mfa/verify", { config: { auth: "session", rateLimit: MFA_RATE } }, async (req, reply) => {
    const session = requireSession(req);
    const body = parse(MfaVerifyRequest, req.body);
    const created = await ctx.auth.verifyMfa(session, body.code, clientOf(req));
    if (!created) return ctx.auth.me(session);
    setSessionCookies(reply, created, secure);
    return ctx.auth.me(created.session);
  });

  app.post("/auth/logout", { config: { auth: "session" } }, async (req, reply) => {
    const session = requireSession(req);
    await ctx.auth.logout(session, actorOf(req));
    ctx.hub.disconnectWhere((c) => c.sessionId === session.id, 4001, "logged out");
    clearSessionCookies(reply, secure);
    return reply.status(204).send();
  });

  app.get("/auth/me", { config: { auth: "session" } }, async (req) => ctx.auth.me(requireSession(req)));

  app.post("/auth/password", async (req, reply) => {
    const body = parse(ChangePasswordRequest, req.body);
    await ctx.auth.changePassword(requireSession(req), body.currentPassword, body.newPassword, actorOf(req));
    return reply.status(204).send();
  });

  app.post("/auth/mfa/enroll", async (req) => ctx.auth.startMfaEnrollment(requireSession(req), actorOf(req)));

  app.post("/auth/mfa/enroll/confirm", async (req, reply) => {
    const body = parse(MfaEnrollConfirm, req.body);
    await ctx.auth.confirmMfaEnrollment(requireSession(req), body.code, actorOf(req));
    return reply.status(204).send();
  });

  app.post("/auth/mfa/disable", async (req, reply) => {
    const body = parse(MfaVerifyRequest, req.body);
    await ctx.auth.disableMfa(requireSession(req), body.code, actorOf(req));
    return reply.status(204).send();
  });
}
