import type { Principal } from "../rbac/authorize.js";

export interface SessionUser {
  id: string;
  email: string;
  displayName: string;
  status: string;
  mfaEnabled: boolean;
}

export interface SessionInfo {
  id: string;
  tokenHash: string;
  /** sha256 of the session-bound CSRF token (compared against the header). */
  csrfTokenHash: string;
  createdAt: Date;
  lastSeenAt: Date;
  expiresAt: Date;
  mfaVerified: boolean;
  user: SessionUser;
}

/**
 * Route-level auth mode (`config.auth`):
 *  - `public`: no session needed (setup, login, health)
 *  - `session`: any valid session, even one still waiting for MFA (`/auth/me`, `/auth/logout`, `/auth/mfa/verify`)
 *  - `user` (default): fully authenticated session; principal loaded
 */
export type AuthMode = "public" | "session" | "user";

declare module "fastify" {
  interface FastifyContextConfig {
    auth?: AuthMode;
    /** Set false to exempt a state-changing route from the CSRF header check (login/setup only). */
    csrf?: boolean;
  }
  interface FastifyRequest {
    session: SessionInfo | null;
    principal: Principal | null;
  }
}
