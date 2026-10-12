import { redirect } from "@tanstack/react-router";
import type { QueryClient } from "@tanstack/react-query";
import type { Me } from "@blockforge/contracts";
import { isApiError } from "./api/errors";
import { meQuery } from "./queries";

/**
 * Only same-origin, absolute-path destinations are honoured after login (no open redirects:
 * "//evil.example", "https://…", "/\\evil" and control characters are rejected).
 */
export function sanitizeRedirect(raw: unknown, fallback = "/"): string {
  if (typeof raw !== "string" || raw.length === 0 || raw.length > 2048) return fallback;
  if (!raw.startsWith("/") || raw.startsWith("//") || raw.startsWith("/\\")) return fallback;
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f]/.test(raw)) return fallback;
  if (/^\/(login|mfa|setup)(\/|\?|#|$)/.test(raw)) return fallback;
  return raw;
}

/** Where an unauthenticated / half-authenticated session must go, or null when it may proceed. */
export type AuthRedirect = { to: "/login" | "/mfa" | "/setup"; redirect?: string };

export function authRedirectFor(code: string, destination: string): AuthRedirect | null {
  const redirectTo = sanitizeRedirect(destination);
  switch (code) {
    case "UNAUTHENTICATED":
      return { to: "/login", redirect: redirectTo };
    case "MFA_REQUIRED":
      return { to: "/mfa", redirect: redirectTo };
    case "SETUP_REQUIRED":
      return { to: "/setup" };
    default:
      return null;
  }
}

function toRedirect(target: AuthRedirect): never {
  if (target.to === "/setup") throw redirect({ to: "/setup" });
  throw redirect({ to: target.to, search: { redirect: target.redirect } });
}

/**
 * Route guard for the authenticated area (`beforeLoad` of the `_app` layout). Resolves the
 * session via the cached `me` query and redirects to login / MFA / setup when needed.
 */
export async function requireSession(queryClient: QueryClient, destination: string): Promise<Me> {
  let me: Me;
  try {
    me = await queryClient.ensureQueryData(meQuery);
  } catch (err) {
    if (isApiError(err)) {
      const target = authRedirectFor(err.code, destination);
      if (target) toRedirect(target);
    }
    throw err;
  }
  if (me.user.mfaEnabled && !me.session.mfaVerified) {
    toRedirect({ to: "/mfa", redirect: sanitizeRedirect(destination) });
  }
  return me;
}

/** For /login and /setup: an already-signed-in user goes straight to the app. */
export async function redirectIfSignedIn(queryClient: QueryClient, destination: unknown): Promise<void> {
  const cached = queryClient.getQueryData(meQuery.queryKey);
  let me: Me | null = cached ?? null;
  if (!me) {
    try {
      me = await queryClient.fetchQuery(meQuery);
    } catch {
      return; // not signed in (or the API is down): stay on the public page
    }
  }
  if (me && (!me.user.mfaEnabled || me.session.mfaVerified)) {
    throw redirect({ href: sanitizeRedirect(destination) });
  }
}
