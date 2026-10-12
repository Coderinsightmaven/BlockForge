import {
  ApiError as ApiErrorBody,
  CSRF_COOKIE,
  CSRF_HEADER,
  IDEMPOTENCY_HEADER,
  REQUEST_ID_HEADER,
} from "@blockforge/contracts";
import type { z } from "zod";
import { ApiError, codeForStatus } from "./errors";

export type HttpMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
export type QueryValue = string | number | boolean | null | undefined;

export interface RequestOptions<T> {
  query?: Record<string, QueryValue | QueryValue[]>;
  body?: unknown;
  /** Response body schema; responses that do not match are rejected as INVALID_RESPONSE. */
  schema?: z.ZodType<T>;
  signal?: AbortSignal;
  /** Correlation id; generated per request when omitted and echoed on errors. */
  requestId?: string;
  /** Sent as `idempotency-key` on job-creating routes; reused on the automatic CSRF retry. */
  idempotencyKey?: string;
  /** Auth endpoints handle their own 401/MFA flow and must not trigger the global redirect. */
  skipAuthRedirect?: boolean;
}

export interface ApiClientConfig {
  baseUrl?: string;
  fetch?: typeof fetch;
  /** Called for UNAUTHENTICATED / MFA_REQUIRED / SETUP_REQUIRED (e.g. redirect to /login). */
  onAuthError?: (error: ApiError) => void;
  /** Re-reads the session's CSRF token (GET /auth/me) after a CSRF_INVALID rejection. */
  refreshCsrfToken?: () => Promise<string | null>;
  /** Overridable for tests. */
  readCookie?: (name: string) => string | null;
  generateId?: () => string;
}

const SAFE_METHODS = new Set<HttpMethod>(["GET"]);

function defaultReadCookie(name: string): string | null {
  if (typeof document === "undefined") return null;
  for (const part of document.cookie.split(";")) {
    const [k, ...v] = part.trim().split("=");
    if (k === name) return decodeURIComponent(v.join("="));
  }
  return null;
}

function defaultGenerateId(): string {
  return (
    globalThis.crypto?.randomUUID?.() ?? `${Date.now().toString(16)}-${Math.random().toString(16).slice(2)}`
  );
}

export function newIdempotencyKey(): string {
  return defaultGenerateId();
}

export function buildQueryString(query: RequestOptions<unknown>["query"]): string {
  if (!query) return "";
  const params = new URLSearchParams();
  for (const [key, raw] of Object.entries(query)) {
    const values = Array.isArray(raw) ? raw : [raw];
    for (const v of values) {
      if (v === undefined || v === null || v === "") continue;
      params.append(key, String(v));
    }
  }
  const s = params.toString();
  return s ? `?${s}` : "";
}

async function readJson(res: Response): Promise<unknown> {
  const text = await res.text();
  if (!text) return undefined;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return text;
  }
}

export class ApiClient {
  private csrfToken: string | null = null;
  private config: ApiClientConfig;

  constructor(config: ApiClientConfig = {}) {
    this.config = config;
  }

  configure(patch: Partial<ApiClientConfig>): void {
    this.config = { ...this.config, ...patch };
  }

  setCsrfToken(token: string | null): void {
    this.csrfToken = token;
  }

  /** In-memory token from `Me.csrfToken`, falling back to the readable CSRF cookie. */
  getCsrfToken(): string | null {
    return this.csrfToken ?? (this.config.readCookie ?? defaultReadCookie)(CSRF_COOKIE);
  }

  get<T>(path: string, opts: RequestOptions<T> = {}): Promise<T> {
    return this.request("GET", path, opts);
  }
  post<T>(path: string, opts: RequestOptions<T> = {}): Promise<T> {
    return this.request("POST", path, opts);
  }
  put<T>(path: string, opts: RequestOptions<T> = {}): Promise<T> {
    return this.request("PUT", path, opts);
  }
  patch<T>(path: string, opts: RequestOptions<T> = {}): Promise<T> {
    return this.request("PATCH", path, opts);
  }
  delete<T>(path: string, opts: RequestOptions<T> = {}): Promise<T> {
    return this.request("DELETE", path, opts);
  }

  async request<T>(method: HttpMethod, path: string, opts: RequestOptions<T> = {}, attempt = 0): Promise<T> {
    const fetchImpl = this.config.fetch ?? globalThis.fetch.bind(globalThis);
    const requestId = opts.requestId ?? (this.config.generateId ?? defaultGenerateId)();
    const headers: Record<string, string> = { accept: "application/json", [REQUEST_ID_HEADER]: requestId };
    if (opts.body !== undefined) headers["content-type"] = "application/json";
    if (!SAFE_METHODS.has(method)) {
      const token = this.getCsrfToken();
      if (token) headers[CSRF_HEADER] = token;
    }
    if (opts.idempotencyKey) headers[IDEMPOTENCY_HEADER] = opts.idempotencyKey;

    const url = `${this.config.baseUrl ?? "/api/v1"}${path}${buildQueryString(opts.query)}`;
    let res: Response;
    try {
      res = await fetchImpl(url, {
        method,
        headers,
        body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
        credentials: "include",
        signal: opts.signal,
      });
    } catch (err) {
      // Cancellation (TanStack Query unmounts, superseded requests) is not an API failure.
      if ((err as { name?: unknown } | null)?.name === "AbortError") throw err;
      throw new ApiError({
        code: "NETWORK_ERROR",
        message: "Could not reach the BlockForge control plane. Check your connection and try again.",
        status: 0,
        requestId,
      });
    }

    const responseRequestId = res.headers.get(REQUEST_ID_HEADER) ?? requestId;

    if (!res.ok) {
      const error = await this.toApiError(res, responseRequestId);
      if (
        error.code === "CSRF_INVALID" &&
        attempt === 0 &&
        !SAFE_METHODS.has(method) &&
        this.config.refreshCsrfToken
      ) {
        const fresh = await this.config.refreshCsrfToken().catch(() => null);
        if (fresh) {
          this.csrfToken = fresh;
          return this.request(method, path, opts, attempt + 1);
        }
      }
      if (error.isAuthRedirect && !opts.skipAuthRedirect) this.config.onAuthError?.(error);
      throw error;
    }

    if (res.status === 204) return undefined as T;
    const data = await readJson(res);
    if (!opts.schema) return data as T;
    const parsed = opts.schema.safeParse(data);
    if (!parsed.success) {
      console.error(`[api] ${method} ${path} response does not match the contract`, parsed.error.issues);
      throw new ApiError({
        code: "INVALID_RESPONSE",
        message: "The control plane returned data this version of the web app does not understand.",
        status: res.status,
        requestId: responseRequestId,
        details: parsed.error.issues,
      });
    }
    return parsed.data;
  }

  private async toApiError(res: Response, requestId: string): Promise<ApiError> {
    const body = await readJson(res).catch(() => undefined);
    const parsed = ApiErrorBody.safeParse(body);
    if (parsed.success) {
      const e = parsed.data.error;
      return new ApiError({
        code: e.code,
        message: e.message,
        status: res.status,
        requestId: e.requestId || requestId,
        details: e.details,
      });
    }
    return new ApiError({
      code: codeForStatus(res.status),
      message: `Request failed (HTTP ${res.status}${res.statusText ? ` ${res.statusText}` : ""}).`,
      status: res.status,
      requestId,
    });
  }
}

/** The app-wide client; `main.tsx` wires its auth and CSRF hooks. */
export const apiClient = new ApiClient();
