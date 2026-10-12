import type { QueryClient } from "@tanstack/react-query";
import type { RegisteredRouter } from "@tanstack/react-router";
import { apiClient } from "./api/client";
import type { ApiClient } from "./api/client";
import { authRedirectFor } from "./auth";
import type { AuthRedirect } from "./auth";
import { qk } from "./query-keys";

export interface SessionEndDeps {
  queryClient: QueryClient;
  /** Current location (read at call time). */
  location: () => { pathname: string; href: string };
  navigate: (target: AuthRedirect) => Promise<unknown>;
  client?: Pick<ApiClient, "setCsrfToken">;
}

/**
 * Handles "the session can no longer make requests" (UNAUTHENTICATED / MFA_REQUIRED /
 * SETUP_REQUIRED), from any API call or from a background `me` refresh:
 *  1. forget the in-memory CSRF token — it belongs to the old session; the next one comes with the
 *     new `Me` or, until then, from the rotated `bf_csrf` cookie;
 *  2. drop the cached `me` so /login does not bounce straight back into the app;
 *  3. navigate (once, even if many requests fail together), keeping the destination.
 * Returns whether the code was an auth redirect.
 */
export function createSessionEndHandler(deps: SessionEndDeps): (code: string) => boolean {
  let redirecting = false;
  return (code) => {
    const location = deps.location();
    const target = authRedirectFor(code, location.href);
    if (!target) return false;
    (deps.client ?? apiClient).setCsrfToken(null);
    if (redirecting || location.pathname === target.to) return true;
    redirecting = true;
    deps.queryClient.removeQueries({ queryKey: qk.auth.me });
    void deps.navigate(target).finally(() => {
      redirecting = false;
      if (target.to === "/login") deps.queryClient.clear();
    });
    return true;
  };
}

export function navigateToAuthPage(router: RegisteredRouter, target: AuthRedirect): Promise<void> {
  return target.to === "/setup"
    ? router.navigate({ to: "/setup" })
    : router.navigate({ to: target.to, search: { redirect: target.redirect } });
}
