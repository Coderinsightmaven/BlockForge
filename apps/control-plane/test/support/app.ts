import { randomBytes } from "node:crypto";
import type { AddressInfo } from "node:net";
import { CSRF_HEADER } from "@blockforge/contracts";
import type { InjectOptions, LightMyRequestResponse } from "fastify";
import { pino } from "pino";
import { buildApp, type BuildAppOptions, type BuiltApp } from "../../src/app.js";
import { loadConfig, type AppConfig } from "../../src/config/env.js";
import type { Clock } from "../../src/lib/clock.js";
import { testPool, truncateAll } from "./db.js";
import { TEST_DATABASE_URL, TEST_PGBOSS_SCHEMA, TEST_PUBLIC_URL, TEST_VICTORIA_METRICS_URL } from "./env.js";

/** Every response body seen by any test client (used to assert secrets never leak). */
export const responseLog: { method: string; url: string; status: number; body: string }[] = [];

export interface TestApp extends BuiltApp {
  baseUrl: string;
  wsBaseUrl: string;
  setupToken: string | null;
  close(): Promise<void>;
}

export function testConfig(env: Record<string, string> = {}): AppConfig {
  return loadConfig({
    NODE_ENV: "test",
    DATABASE_URL: TEST_DATABASE_URL,
    VICTORIA_METRICS_URL: TEST_VICTORIA_METRICS_URL,
    PUBLIC_URL: TEST_PUBLIC_URL,
    LOG_LEVEL: process.env.TEST_LOG_LEVEL ?? "silent",
    PGBOSS_SCHEMA: TEST_PGBOSS_SCHEMA,
    DATA_DIR: ".data/test",
    AGENT_HEARTBEAT_INTERVAL_MS: "15000",
    NODE_SWEEP_INTERVAL_MS: "60000",
    ALERT_EVAL_INTERVAL_MS: "300000",
    METRICS_FLUSH_INTERVAL_MS: "200",
    ...env,
  });
}

/** Truncates the database, builds the app against it and listens on an ephemeral port. */
export async function startTestApp(
  opts: { env?: Record<string, string>; clock?: Clock; background?: boolean } & Partial<Omit<BuildAppOptions, "config">> = {},
): Promise<TestApp> {
  await truncateAll();
  let setupToken: string | null = null;
  const config = testConfig(opts.env);
  const built = await buildApp({
    ...opts,
    config,
    logger: pino({ level: config.logLevel }),
    pool: testPool(),
    masterKey: opts.masterKey ?? randomBytes(32),
    ...(opts.clock ? { clock: opts.clock } : {}),
    startBackground: opts.background ?? false,
    setupTokenSink: (t) => {
      setupToken = t;
    },
  });
  built.app.addHook("onSend", async (req, reply, payload) => {
    if (typeof payload === "string") responseLog.push({ method: req.method, url: req.url, status: reply.statusCode, body: payload });
    return payload;
  });
  await built.app.listen({ host: "127.0.0.1", port: 0 });
  const { port } = built.app.server.address() as AddressInfo;
  return {
    ...built,
    baseUrl: `http://127.0.0.1:${port}`,
    wsBaseUrl: `ws://127.0.0.1:${port}`,
    setupToken,
    close: () => built.app.close(),
  };
}

/** Cookie-jar + CSRF aware client over `app.inject`. */
export class ApiClient {
  cookies = new Map<string, string>();
  csrf: string | null = null;

  constructor(private readonly t: TestApp) {}

  cookieHeader(): string {
    return [...this.cookies].map(([k, v]) => `${k}=${v}`).join("; ");
  }

  async request(method: InjectOptions["method"], url: string, body?: unknown, headers: Record<string, string> = {}): Promise<LightMyRequestResponse> {
    const res = await this.t.app.inject({
      method,
      url: `/api/v1${url}`,
      headers: {
        ...(this.cookies.size ? { cookie: this.cookieHeader() } : {}),
        ...(this.csrf && method !== "GET" ? { [CSRF_HEADER]: this.csrf } : {}),
        ...headers,
      },
      ...(body !== undefined ? { payload: body as InjectOptions["payload"] } : {}),
    });
    for (const c of res.cookies) {
      if (c.value === "" || (c.expires instanceof Date && c.expires.getTime() < Date.now())) this.cookies.delete(c.name);
      else this.cookies.set(c.name, c.value);
    }
    return res;
  }

  get(url: string, headers?: Record<string, string>) {
    return this.request("GET", url, undefined, headers);
  }
  post(url: string, body?: unknown, headers?: Record<string, string>) {
    return this.request("POST", url, body ?? {}, headers);
  }
  patch(url: string, body: unknown) {
    return this.request("PATCH", url, body);
  }
  put(url: string, body: unknown) {
    return this.request("PUT", url, body);
  }
  delete(url: string) {
    return this.request("DELETE", url);
  }

  /** Refreshes the CSRF token from `/auth/me`. */
  async refreshCsrf(): Promise<void> {
    const res = await this.get("/auth/me");
    if (res.statusCode === 200) this.csrf = res.json().csrfToken;
  }

  async setup(email = "owner@example.com", password = "correct horse battery staple"): Promise<LightMyRequestResponse> {
    const res = await this.post("/auth/setup", { setupToken: this.t.setupToken, email, displayName: "Owner", password });
    if (res.statusCode === 201) this.csrf = res.json().csrfToken;
    return res;
  }

  async login(email: string, password: string): Promise<LightMyRequestResponse> {
    this.cookies.clear();
    this.csrf = null;
    const res = await this.post("/auth/login", { email, password });
    if (res.statusCode === 200) {
      const body = res.json();
      if (body.me) this.csrf = body.me.csrfToken;
      else await this.refreshCsrf();
    }
    return res;
  }
}

export const OWNER_PASSWORD = "correct horse battery staple";

/** A fresh app with a completed setup and a logged-in owner client. */
export async function startWithOwner(opts: Parameters<typeof startTestApp>[0] = {}): Promise<{ t: TestApp; owner: ApiClient }> {
  const t = await startTestApp(opts);
  const owner = new ApiClient(t);
  const res = await owner.setup("owner@example.com", OWNER_PASSWORD);
  if (res.statusCode !== 201) throw new Error(`setup failed: ${res.statusCode} ${res.body}`);
  return { t, owner };
}

/** Creates a user with role bindings (as the owner) and returns a logged-in client for them. */
export async function createUserClient(
  t: TestApp,
  owner: ApiClient,
  email: string,
  roles: { roleKey: string; scopeType: string; scopeId: string | null }[],
): Promise<ApiClient> {
  const password = "user password is long enough";
  const res = await owner.post("/users", { email, displayName: email.split("@")[0], password, roles });
  if (res.statusCode !== 201) throw new Error(`create user failed: ${res.statusCode} ${res.body}`);
  const client = new ApiClient(t);
  const login = await client.login(email, password);
  if (login.statusCode !== 200) throw new Error(`login failed: ${login.statusCode} ${login.body}`);
  return client;
}
