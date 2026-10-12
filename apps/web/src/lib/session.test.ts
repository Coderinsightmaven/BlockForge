import { QueryClient } from "@tanstack/react-query";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CSRF_HEADER } from "@blockforge/contracts";
import { apiErrorBody, jsonResponse, makeMe } from "@/test/fixtures";
import { apiClient } from "./api/client";
import { authApi } from "./api/endpoints";
import { qk } from "./query-keys";
import { createSessionEndHandler } from "./session";

function setCookie(value: string | null) {
  document.cookie =
    value === null ? "bf_csrf=; expires=Thu, 01 Jan 1970 00:00:00 GMT; path=/" : `bf_csrf=${value}; path=/`;
}

afterEach(() => {
  vi.unstubAllGlobals();
  apiClient.setCsrfToken(null);
  setCookie(null);
});

describe("CSRF token across sessions", () => {
  it("does not reuse the previous session's token for MFA verify after login returns mfa_required", async () => {
    const calls: Array<{ url: string; headers: Record<string, string> }> = [];
    const responses = [
      jsonResponse({ status: "mfa_required" }),
      jsonResponse(makeMe({ mfaEnabled: true, mfaVerified: true, csrfToken: "token-after-mfa" })),
    ];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init: RequestInit) => {
        calls.push({ url, headers: init.headers as Record<string, string> });
        return responses.shift()!;
      }),
    );

    apiClient.setCsrfToken("stale-token-from-previous-session");
    // The server rotates the readable cookie when it creates the new (pending-MFA) session.
    setCookie("fresh-cookie-token");

    const res = await authApi.login({ email: "owner@example.test", password: "correct horse battery" });
    expect(res.status).toBe("mfa_required");
    expect(apiClient.getCsrfToken()).toBe("fresh-cookie-token");

    await authApi.verifyMfa({ code: "123456" });
    expect(calls[1]!.url).toBe("/api/v1/auth/mfa/verify");
    expect(calls[1]!.headers[CSRF_HEADER]).toBe("fresh-cookie-token");
    // Once the verified session's Me arrives, its token is used.
    expect(apiClient.getCsrfToken()).toBe("token-after-mfa");
  });

  it("forgets a stale token when setup starts a new session", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => jsonResponse(apiErrorBody("VALIDATION_FAILED"), { status: 400 })),
    );
    apiClient.setCsrfToken("stale");
    await authApi
      .setup({
        setupToken: "x".repeat(20),
        email: "a@example.test",
        displayName: "A",
        password: "p".repeat(12),
      })
      .catch(() => {});
    expect(apiClient.getCsrfToken()).toBeNull();
  });
});

describe("createSessionEndHandler", () => {
  function setup(pathname = "/nodes", href = "/nodes?q=1") {
    const queryClient = new QueryClient();
    queryClient.setQueryData(qk.auth.me, makeMe());
    queryClient.setQueryData(qk.overview, { cached: true });
    const client = { setCsrfToken: vi.fn() };
    let resolveNav: () => void = () => {};
    const navigate = vi.fn(() => new Promise<void>((r) => (resolveNav = r)));
    const handler = createSessionEndHandler({
      queryClient,
      client,
      navigate,
      location: () => ({ pathname, href }),
    });
    return { queryClient, client, navigate, handler, finishNav: () => resolveNav() };
  }

  it("clears the CSRF token and cached session, then navigates to login once", async () => {
    const { queryClient, client, navigate, handler, finishNav } = setup();
    expect(handler("UNAUTHENTICATED")).toBe(true);
    expect(handler("UNAUTHENTICATED")).toBe(true); // concurrent failures: still one navigation
    expect(client.setCsrfToken).toHaveBeenCalledWith(null);
    expect(queryClient.getQueryData(qk.auth.me)).toBeUndefined();
    expect(navigate).toHaveBeenCalledTimes(1);
    expect(navigate).toHaveBeenCalledWith({ to: "/login", redirect: "/nodes?q=1" });
    finishNav();
    await vi.waitFor(() => expect(queryClient.getQueryData(qk.overview)).toBeUndefined());
  });

  it("routes MFA_REQUIRED to /mfa and keeps other cached data", () => {
    const { queryClient, navigate, handler } = setup();
    handler("MFA_REQUIRED");
    expect(navigate).toHaveBeenCalledWith({ to: "/mfa", redirect: "/nodes?q=1" });
    expect(queryClient.getQueryData(qk.overview)).toEqual({ cached: true });
  });

  it("only clears the token when already on the target page, and ignores other errors", () => {
    const onLogin = setup("/login", "/login");
    onLogin.handler("UNAUTHENTICATED");
    expect(onLogin.client.setCsrfToken).toHaveBeenCalledWith(null);
    expect(onLogin.navigate).not.toHaveBeenCalled();

    const other = setup();
    expect(other.handler("FORBIDDEN")).toBe(false);
    expect(other.client.setCsrfToken).not.toHaveBeenCalled();
  });
});
