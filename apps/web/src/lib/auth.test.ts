import { QueryClient } from "@tanstack/react-query";
import {
  Outlet,
  createMemoryHistory,
  createRootRouteWithContext,
  createRoute,
  createRouter,
  isRedirect,
} from "@tanstack/react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { apiErrorBody, jsonResponse, makeMe } from "@/test/fixtures";
import { apiClient } from "./api/client";
import { authRedirectFor, redirectIfSignedIn, requireSession, sanitizeRedirect } from "./auth";

function stubMe(response: () => Response) {
  const fetchStub = vi.fn(async () => response());
  vi.stubGlobal("fetch", fetchStub);
  return fetchStub;
}

beforeEach(() => apiClient.setCsrfToken(null));
afterEach(() => vi.unstubAllGlobals());

describe("sanitizeRedirect", () => {
  it.each([
    ["/nodes", "/nodes"],
    ["/nodes/abc?tab=metrics#x", "/nodes/abc?tab=metrics#x"],
    ["//evil.example/path", "/"],
    ["/\\evil.example", "/"],
    ["https://evil.example", "/"],
    ["javascript:alert(1)", "/"],
    ["nodes", "/"],
    ["/login?redirect=/x", "/"],
    ["/mfa", "/"],
    ["/x\nSet-Cookie", "/"],
    ["", "/"],
  ])("%j → %j", (input, expected) => {
    expect(sanitizeRedirect(input)).toBe(expected);
  });
  it("rejects non-strings", () => {
    expect(sanitizeRedirect(undefined)).toBe("/");
    expect(sanitizeRedirect(42)).toBe("/");
  });
});

describe("authRedirectFor", () => {
  it("maps auth error codes to pages and preserves the destination", () => {
    expect(authRedirectFor("UNAUTHENTICATED", "/nodes?q=a")).toEqual({
      to: "/login",
      redirect: "/nodes?q=a",
    });
    expect(authRedirectFor("MFA_REQUIRED", "/audit")).toEqual({ to: "/mfa", redirect: "/audit" });
    expect(authRedirectFor("SETUP_REQUIRED", "/")).toEqual({ to: "/setup" });
    expect(authRedirectFor("FORBIDDEN", "/")).toBeNull();
  });
});

describe("requireSession", () => {
  it("returns Me and stores its CSRF token for later mutations", async () => {
    stubMe(() => jsonResponse(makeMe({ csrfToken: "tok-1" })));
    const me = await requireSession(new QueryClient(), "/nodes");
    expect(me.user.email).toBe("owner@example.test");
    expect(apiClient.getCsrfToken()).toBe("tok-1");
  });

  it("redirects to /login with the destination when there is no session", async () => {
    stubMe(() => jsonResponse(apiErrorBody("UNAUTHENTICATED"), { status: 401 }));
    const err = await requireSession(new QueryClient(), "/nodes?tab=tokens").catch((e: unknown) => e);
    expect(isRedirect(err)).toBe(true);
    expect((err as { options: unknown }).options).toMatchObject({
      to: "/login",
      search: { redirect: "/nodes?tab=tokens" },
    });
  });

  it("redirects to /mfa when the API demands the second factor", async () => {
    stubMe(() => jsonResponse(apiErrorBody("MFA_REQUIRED"), { status: 401 }));
    const err = await requireSession(new QueryClient(), "/audit").catch((e: unknown) => e);
    expect((err as { options: unknown }).options).toMatchObject({
      to: "/mfa",
      search: { redirect: "/audit" },
    });
  });

  it("redirects to /mfa when Me reports an unverified MFA session", async () => {
    stubMe(() => jsonResponse(makeMe({ mfaEnabled: true, mfaVerified: false })));
    const err = await requireSession(new QueryClient(), "/").catch((e: unknown) => e);
    expect((err as { options: unknown }).options).toMatchObject({ to: "/mfa" });
  });

  it("redirects to /setup on a fresh installation", async () => {
    stubMe(() => jsonResponse(apiErrorBody("SETUP_REQUIRED"), { status: 409 }));
    const err = await requireSession(new QueryClient(), "/").catch((e: unknown) => e);
    expect((err as { options: unknown }).options).toMatchObject({ to: "/setup" });
  });

  it("rethrows other failures so the route shows an error with retry", async () => {
    stubMe(() => new Response("down", { status: 503 }));
    const err = await requireSession(new QueryClient(), "/").catch((e: unknown) => e);
    expect(isRedirect(err)).toBe(false);
    expect(err).toMatchObject({ code: "UPSTREAM_ERROR" });
  });

  it("uses the cached session without refetching", async () => {
    const fetchStub = stubMe(() => jsonResponse(makeMe()));
    const qc = new QueryClient();
    await requireSession(qc, "/");
    await requireSession(qc, "/nodes");
    expect(fetchStub).toHaveBeenCalledTimes(1);
  });
});

describe("redirectIfSignedIn", () => {
  it("sends a signed-in user to the sanitised destination", async () => {
    stubMe(() => jsonResponse(makeMe()));
    const err = await redirectIfSignedIn(new QueryClient(), "//evil.example").catch((e: unknown) => e);
    expect((err as { options: unknown }).options).toMatchObject({ href: "/" });
  });
  it("stays on the public page without a session", async () => {
    stubMe(() => jsonResponse(apiErrorBody("UNAUTHENTICATED"), { status: 401 }));
    await expect(redirectIfSignedIn(new QueryClient(), "/nodes")).resolves.toBeUndefined();
  });
});

describe("route guard in a router", () => {
  function buildRouter(initial: string) {
    const queryClient = new QueryClient();
    const root = createRootRouteWithContext<{ queryClient: QueryClient }>()({ component: Outlet });
    const login = createRoute({
      getParentRoute: () => root,
      path: "/login",
      validateSearch: (s: Record<string, unknown>) => ({
        redirect: typeof s.redirect === "string" ? s.redirect : undefined,
      }),
    });
    const mfa = createRoute({
      getParentRoute: () => root,
      path: "/mfa",
      validateSearch: (s: Record<string, unknown>) => ({
        redirect: typeof s.redirect === "string" ? s.redirect : undefined,
      }),
    });
    const app = createRoute({
      getParentRoute: () => root,
      id: "_app",
      beforeLoad: async ({ context, location }) => ({
        me: await requireSession(context.queryClient, location.href),
      }),
    });
    const nodes = createRoute({ getParentRoute: () => app, path: "/nodes" });
    const router = createRouter({
      routeTree: root.addChildren([login, mfa, app.addChildren([nodes])]),
      context: { queryClient },
      history: createMemoryHistory({ initialEntries: [initial] }),
    });
    return router;
  }

  it("redirects an anonymous visitor to /login and remembers where they were going", async () => {
    stubMe(() => jsonResponse(apiErrorBody("UNAUTHENTICATED"), { status: 401 }));
    const router = buildRouter("/nodes?q=fra");
    await router.load();
    expect(router.state.location.pathname).toBe("/login");
    expect(router.state.location.search).toEqual({ redirect: "/nodes?q=fra" });
  });

  it("redirects a half-authenticated session to /mfa", async () => {
    stubMe(() => jsonResponse(apiErrorBody("MFA_REQUIRED"), { status: 401 }));
    const router = buildRouter("/nodes");
    await router.load();
    expect(router.state.location.pathname).toBe("/mfa");
  });

  it("lets a signed-in user through", async () => {
    stubMe(() => jsonResponse(makeMe()));
    const router = buildRouter("/nodes");
    await router.load();
    expect(router.state.location.pathname).toBe("/nodes");
    expect(router.state.matches.at(-1)?.routeId).toBe("/_app/nodes");
  });
});
