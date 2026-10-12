import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { CSRF_HEADER, IDEMPOTENCY_HEADER, REQUEST_ID_HEADER } from "@blockforge/contracts";
import { apiErrorBody, jsonResponse } from "@/test/fixtures";
import { ApiClient, buildQueryString } from "./client";
import { ApiError } from "./errors";

type FetchArgs = [string, RequestInit];

function setup(
  responses: Array<Response | Error | DOMException>,
  extra: ConstructorParameters<typeof ApiClient>[0] = {},
) {
  const calls: FetchArgs[] = [];
  const queue = [...responses];
  const fetchStub = vi.fn(async (url: string, init: RequestInit) => {
    calls.push([url, init]);
    const next = queue.shift();
    if (!next) throw new Error("unexpected fetch");
    if (!(next instanceof Response)) throw next;
    return next;
  });
  const onAuthError = vi.fn();
  const client = new ApiClient({
    fetch: fetchStub as unknown as typeof fetch,
    onAuthError,
    readCookie: () => null,
    generateId: () => "generated-id",
    ...extra,
  });
  const header = (i: number, name: string) => (calls[i]![1].headers as Record<string, string>)[name];
  return { client, calls, onAuthError, header, fetchStub };
}

describe("ApiClient requests", () => {
  it("sends cookies, a request id and no CSRF header on GET", async () => {
    const { client, calls, header } = setup([jsonResponse({ ok: true })]);
    client.setCsrfToken("tok");
    await client.get("/nodes", { query: { a: 1, b: undefined, c: null, d: "" } });
    expect(calls[0]![0]).toBe("/api/v1/nodes?a=1");
    expect(calls[0]![1].credentials).toBe("include");
    expect(header(0, REQUEST_ID_HEADER)).toBe("generated-id");
    expect(header(0, CSRF_HEADER)).toBeUndefined();
  });

  it("sends the CSRF token from Me on every state-changing method", async () => {
    const { client, header } = setup([
      jsonResponse({}),
      jsonResponse({}),
      jsonResponse({}),
      new Response(null, { status: 204 }),
    ]);
    client.setCsrfToken("tok-123");
    await client.post("/a", { body: { x: 1 } });
    await client.put("/a", { body: {} });
    await client.patch("/a", { body: {} });
    await client.delete("/a");
    for (let i = 0; i < 4; i++) expect(header(i, CSRF_HEADER)).toBe("tok-123");
    expect(header(0, "content-type")).toBe("application/json");
  });

  it("falls back to the readable CSRF cookie when no token is in memory", async () => {
    const { client, header } = setup([jsonResponse({})], {
      readCookie: (n) => (n === "bf_csrf" ? "cookie-tok" : null),
    });
    await client.post("/a");
    expect(header(0, CSRF_HEADER)).toBe("cookie-tok");
  });

  it("passes caller request ids and idempotency keys through", async () => {
    const { client, header } = setup([jsonResponse({})]);
    await client.post("/servers", { requestId: "caller-req", idempotencyKey: "idem-1", body: {} });
    expect(header(0, REQUEST_ID_HEADER)).toBe("caller-req");
    expect(header(0, IDEMPOTENCY_HEADER)).toBe("idem-1");
  });

  it("returns undefined for 204 and validates bodies against the schema", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const { client } = setup([
      new Response(null, { status: 204 }),
      jsonResponse({ n: 1 }),
      jsonResponse({ n: "x" }),
    ]);
    await expect(client.delete("/a")).resolves.toBeUndefined();
    await expect(client.get("/a", { schema: z.object({ n: z.number() }) })).resolves.toEqual({ n: 1 });
    const err = await client.get("/a", { schema: z.object({ n: z.number() }) }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect((err as ApiError).code).toBe("INVALID_RESPONSE");
  });
});

describe("ApiClient errors", () => {
  it("parses ApiError bodies into a typed error", async () => {
    const { client } = setup([
      jsonResponse(apiErrorBody("CONFLICT", "Node hosts servers", "req-9", { serverCount: 2 }), {
        status: 409,
      }),
    ]);
    const err = (await client.delete("/nodes/x").catch((e: unknown) => e)) as ApiError;
    expect(err).toBeInstanceOf(ApiError);
    expect(err.code).toBe("CONFLICT");
    expect(err.message).toBe("Node hosts servers");
    expect(err.status).toBe(409);
    expect(err.requestId).toBe("req-9");
    expect(err.details).toEqual({ serverCount: 2 });
    expect(err.isRetryable).toBe(false);
  });

  it("derives a code from the status when the body is not an ApiError", async () => {
    const { client } = setup([
      new Response("<html>Bad gateway</html>", { status: 502, headers: { [REQUEST_ID_HEADER]: "edge-1" } }),
    ]);
    const err = (await client.get("/overview").catch((e: unknown) => e)) as ApiError;
    expect(err.code).toBe("UPSTREAM_ERROR");
    expect(err.status).toBe(502);
    expect(err.requestId).toBe("edge-1");
    expect(err.isRetryable).toBe(true);
  });

  it("reports network failures as NETWORK_ERROR", async () => {
    const { client } = setup([new TypeError("Failed to fetch")]);
    const err = (await client.get("/overview").catch((e: unknown) => e)) as ApiError;
    expect(err.code).toBe("NETWORK_ERROR");
    expect(err.status).toBe(0);
  });

  it("re-throws aborts untouched", async () => {
    const { client } = setup([new DOMException("aborted", "AbortError")]);
    const err = await client.get("/overview").catch((e: unknown) => e);
    expect(err).toMatchObject({ name: "AbortError" });
    expect(err).not.toBeInstanceOf(ApiError);
  });
});

describe("ApiClient auth handling", () => {
  it("calls the auth handler on 401 so the app can redirect to login", async () => {
    const { client, onAuthError } = setup([
      jsonResponse(apiErrorBody("UNAUTHENTICATED", "Session expired"), { status: 401 }),
    ]);
    await expect(client.get("/nodes")).rejects.toMatchObject({ code: "UNAUTHENTICATED", status: 401 });
    expect(onAuthError).toHaveBeenCalledTimes(1);
    expect(onAuthError.mock.calls[0]![0]).toBeInstanceOf(ApiError);
  });

  it("treats a bare 401 without a body as UNAUTHENTICATED", async () => {
    const { client, onAuthError } = setup([new Response(null, { status: 401 })]);
    await expect(client.get("/nodes")).rejects.toMatchObject({ code: "UNAUTHENTICATED" });
    expect(onAuthError).toHaveBeenCalledOnce();
  });

  it("routes MFA_REQUIRED and SETUP_REQUIRED to the handler too", async () => {
    const { client, onAuthError } = setup([
      jsonResponse(apiErrorBody("MFA_REQUIRED"), { status: 401 }),
      jsonResponse(apiErrorBody("SETUP_REQUIRED"), { status: 409 }),
    ]);
    await client.get("/a").catch(() => {});
    await client.get("/b").catch(() => {});
    expect(onAuthError.mock.calls.map((c) => (c[0] as ApiError).code)).toEqual([
      "MFA_REQUIRED",
      "SETUP_REQUIRED",
    ]);
  });

  it("does not redirect for auth endpoints that handle 401 themselves", async () => {
    const { client, onAuthError } = setup([jsonResponse(apiErrorBody("UNAUTHENTICATED"), { status: 401 })]);
    await client.get("/auth/me", { skipAuthRedirect: true }).catch(() => {});
    expect(onAuthError).not.toHaveBeenCalled();
  });

  it("does not call the handler for other errors", async () => {
    const { client, onAuthError } = setup([jsonResponse(apiErrorBody("FORBIDDEN"), { status: 403 })]);
    await client.get("/users").catch(() => {});
    expect(onAuthError).not.toHaveBeenCalled();
  });

  it("refreshes the CSRF token once on CSRF_INVALID and retries with the same idempotency key", async () => {
    const refreshCsrfToken = vi.fn(async () => "fresh-token");
    const { client, header, calls } = setup(
      [jsonResponse(apiErrorBody("CSRF_INVALID"), { status: 403 }), jsonResponse({ ok: 1 })],
      { refreshCsrfToken },
    );
    client.setCsrfToken("stale");
    await expect(client.post("/x", { idempotencyKey: "k1" })).resolves.toEqual({ ok: 1 });
    expect(refreshCsrfToken).toHaveBeenCalledOnce();
    expect(calls).toHaveLength(2);
    expect(header(0, CSRF_HEADER)).toBe("stale");
    expect(header(1, CSRF_HEADER)).toBe("fresh-token");
    expect(header(1, IDEMPOTENCY_HEADER)).toBe("k1");
  });

  it("gives up after one CSRF retry", async () => {
    const refreshCsrfToken = vi.fn(async () => "fresh-token");
    const { client } = setup(
      [
        jsonResponse(apiErrorBody("CSRF_INVALID"), { status: 403 }),
        jsonResponse(apiErrorBody("CSRF_INVALID"), { status: 403 }),
      ],
      { refreshCsrfToken },
    );
    await expect(client.post("/x")).rejects.toMatchObject({ code: "CSRF_INVALID" });
    expect(refreshCsrfToken).toHaveBeenCalledOnce();
  });
});

describe("buildQueryString", () => {
  it("encodes values, repeats arrays and skips empties", () => {
    expect(buildQueryString({ a: "x y", b: [1, 2], c: undefined, d: false })).toBe("?a=x+y&b=1&b=2&d=false");
    expect(buildQueryString({})).toBe("");
  });
});
