import { CSRF_COOKIE, CSRF_HEADER, SESSION_COOKIE, type Permission } from "@blockforge/contracts";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { AuditActor, AuditService } from "../audit/service.js";
import type { CreatedSession, SessionService } from "../auth/sessions.js";
import { SESSION_ABSOLUTE_MS } from "../auth/sessions.js";
import { AppError, forbidden, mfaRequired, unauthenticated, validationDetails } from "../lib/errors.js";
import { authorize, type Principal, type Resource } from "../rbac/authorize.js";
import type { RbacService } from "../rbac/service.js";
import type { SessionInfo } from "./types.js";

const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

export interface AuthHookDeps {
  sessions: SessionService;
  rbac: RbacService;
  cookieSecure: boolean;
  /** PUBLIC_URL origin; a state-changing request carrying another `Origin` is rejected. */
  publicOrigin: string;
}

/**
 * Registers session resolution, the MFA gate and CSRF enforcement for the `/api/v1` scope.
 * Order: session → CSRF (non-GET) → MFA gate → principal. Route `config.auth` selects the mode.
 */
export function registerAuthHooks(app: FastifyInstance, deps: AuthHookDeps): void {
  app.decorateRequest("session", null);
  app.decorateRequest("principal", null);

  app.addHook("onRequest", async (req) => {
    const token = req.cookies[SESSION_COOKIE];
    if (token) req.session = await deps.sessions.lookup(token);
  });

  app.addHook("preHandler", async (req) => {
    const mode = req.routeOptions.config.auth ?? "user";
    const unsafe = !SAFE_METHODS.has(req.method);
    if (unsafe) {
      // Browsers send Origin on cross-origin (and same-origin POST) requests; non-browser clients
      // may omit it. A present but foreign Origin is always rejected.
      const origin = req.headers.origin;
      if (origin !== undefined && origin !== deps.publicOrigin) throw new AppError(403, "CSRF_INVALID", "Origin not allowed");
      if (req.routeOptions.config.csrf === false) {
        // Pre-session routes (login/setup) cannot carry the CSRF header; require a JSON body, which
        // a cross-site HTML form cannot produce without a CORS preflight.
        const type = req.headers["content-type"] ?? "";
        if (!/^application\/json(;|$)/i.test(type)) {
          throw new AppError(415, "VALIDATION_FAILED", "Content-Type must be application/json", validationDetails("Content-Type must be application/json"));
        }
      }
    }
    if (mode === "public") return;
    const session = req.session;
    if (!session) throw unauthenticated();
    if (unsafe && req.routeOptions.config.csrf !== false && req.routeOptions.config.csrf !== "token") {
      const header = req.headers[CSRF_HEADER];
      if (!deps.sessions.verifyCsrf(session, typeof header === "string" ? header : undefined)) {
        throw new AppError(403, "CSRF_INVALID", "Missing or invalid CSRF token");
      }
    }
    if (mode === "session") return;
    // Strict: a session created while MFA was required stays gated even if MFA is later disabled.
    if (!session.mfaVerified) throw mfaRequired();
    req.principal = await deps.rbac.loadPrincipal(session.user.id);
    if (!req.principal) throw unauthenticated();
  });
}

export function setSessionCookies(reply: FastifyReply, created: CreatedSession, secure: boolean): void {
  const maxAge = Math.floor(SESSION_ABSOLUTE_MS / 1000);
  reply.setCookie(SESSION_COOKIE, created.token, { httpOnly: true, sameSite: "lax", secure, path: "/", maxAge });
  // Convenience copy for the SPA; the authoritative check is the session-bound header (CSRF_HEADER).
  reply.setCookie(CSRF_COOKIE, created.csrfToken, { httpOnly: false, sameSite: "strict", secure, path: "/", maxAge });
}

export function clearSessionCookies(reply: FastifyReply, secure: boolean): void {
  reply.clearCookie(SESSION_COOKIE, { path: "/", secure, httpOnly: true, sameSite: "lax" });
  reply.clearCookie(CSRF_COOKIE, { path: "/", secure, sameSite: "strict" });
}

export function requireSession(req: FastifyRequest): SessionInfo {
  if (!req.session) throw unauthenticated();
  return req.session;
}

export function requirePrincipal(req: FastifyRequest): Principal {
  if (!req.principal) throw unauthenticated();
  return req.principal;
}

export function actorOf(req: FastifyRequest): AuditActor {
  const s = req.session;
  return {
    actorType: "user",
    actorId: s?.user.id ?? null,
    actorName: s?.user.email ?? null,
    ip: req.ip ?? null,
    requestId: String(req.id),
  };
}

export function clientOf(req: FastifyRequest): { ip: string | null; userAgent: string | null; requestId: string } {
  const ua = req.headers["user-agent"];
  return { ip: req.ip ?? null, userAgent: typeof ua === "string" ? ua : null, requestId: String(req.id) };
}

/**
 * Authorisation guard for route handlers. Denials are written to the audit log (outcome `denied`)
 * and answered with 403 FORBIDDEN.
 */
export async function requirePermission(
  audit: AuditService,
  req: FastifyRequest,
  permission: Permission,
  resource: Resource,
): Promise<Principal> {
  const principal = requirePrincipal(req);
  if (authorize(principal, permission, resource)) return principal;
  await audit.record({
    ...actorOf(req),
    action: "authz.denied",
    targetType: resource.type,
    targetId: resource.type === "global" ? null : resource.id,
    outcome: "denied",
    details: { permission, method: req.method, route: req.routeOptions.url ?? req.url },
  });
  throw forbidden();
}
