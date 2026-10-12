import { isAbsolute, resolve } from "node:path";
import { z } from "zod";

const DEV_DATABASE_URL = "postgres://blockforge:blockforge-dev-only@127.0.0.1:55432/blockforge";
const DEV_VICTORIA_METRICS_URL = "http://127.0.0.1:58428";

const boolish = z
  .enum(["true", "false", "1", "0", "yes", "no"])
  .transform((v) => v === "true" || v === "1" || v === "yes");

const intFrom = (min: number, max: number) => z.coerce.number().int().min(min).max(max);

const originOf = (url: string) => new URL(url).origin;

/**
 * `TRUST_PROXY`: "false" (default), "true", a hop count, or a comma-separated list of proxy
 * addresses/CIDRs. Only enable behind a reverse proxy you control — it makes `X-Forwarded-For`
 * the client IP used for rate limiting and audit.
 */
const TrustProxy = z
  .string()
  .optional()
  .transform((v): boolean | number | string[] => {
    if (v === undefined || v === "" || v === "false" || v === "0") return false;
    if (v === "true") return true;
    if (/^\d+$/.test(v)) return Number(v);
    return v
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
  });

const EnvSchema = z
  .object({
    NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
    DATABASE_URL: z.string().url().optional(),
    VICTORIA_METRICS_URL: z.string().url().optional(),
    PUBLIC_URL: z.string().url().default("http://127.0.0.1:5173"),
    /** URL agents use to reach the control plane (defaults to PUBLIC_URL). */
    AGENT_URL: z.string().url().optional(),
    LISTEN_HOST: z.string().min(1).default("127.0.0.1"),
    LISTEN_PORT: intFrom(0, 65535).default(8080),
    DATA_DIR: z.string().min(1).default(".data"),
    BLOCKFORGE_MASTER_KEY: z.string().optional(),
    COOKIE_SECURE: boolish.optional(),
    LOG_LEVEL: z.enum(["fatal", "error", "warn", "info", "debug", "trace", "silent"]).default("info"),
    TRUST_PROXY: TrustProxy,
    PGBOSS_SCHEMA: z
      .string()
      .regex(/^[a-z_][a-z0-9_]{0,62}$/)
      .default("pgboss"),
    /** Built SPA to serve from the same origin (optional; the Vite dev server is used in development). */
    WEB_DIST_DIR: z.string().optional(),
    SMTP_HOST: z.string().optional(),
    SMTP_PORT: intFrom(1, 65535).optional(),
    SMTP_SECURE: boolish.optional(),
    SMTP_USER: z.string().optional(),
    SMTP_PASSWORD: z.string().optional(),
    SMTP_FROM: z.string().optional(),
    AGENT_HEARTBEAT_INTERVAL_MS: intFrom(1000, 300_000).default(15_000),
    AGENT_METRICS_INTERVAL_MS: intFrom(1000, 300_000).default(5000),
    /** A cleanly disconnected node turns from `unreachable` into `offline` after this long. */
    NODE_OFFLINE_AFTER_MS: intFrom(1000, 86_400_000).default(5 * 60_000),
    NODE_SWEEP_INTERVAL_MS: intFrom(50, 60_000).default(5000),
    /** Soft per-session budget of queued agent frame bytes (backpressure above, shedding above 2×). */
    AGENT_MAX_QUEUED_BYTES: intFrom(64 * 1024, 1024 * 1024 * 1024).default(32 * 1024 * 1024),
    ALERT_EVAL_INTERVAL_MS: intFrom(100, 300_000).default(20_000),
    METRICS_FLUSH_INTERVAL_MS: intFrom(50, 60_000).default(1000),
    /** Requests per minute and personal API key. */
    API_KEY_RATE_LIMIT_PER_MIN: intFrom(1, 100_000).default(120),
    /** Scheduler tick (due schedules are claimed with FOR UPDATE SKIP LOCKED). */
    SCHEDULER_INTERVAL_MS: intFrom(100, 300_000).default(15_000),
  })
  .superRefine((env, ctx) => {
    if (env.NODE_ENV === "production") {
      if (!env.DATABASE_URL) ctx.addIssue({ code: "custom", path: ["DATABASE_URL"], message: "required in production" });
      if (!env.VICTORIA_METRICS_URL)
        ctx.addIssue({ code: "custom", path: ["VICTORIA_METRICS_URL"], message: "required in production" });
      if (!env.BLOCKFORGE_MASTER_KEY)
        ctx.addIssue({ code: "custom", path: ["BLOCKFORGE_MASTER_KEY"], message: "required in production" });
    }
    if (env.SMTP_HOST && !env.SMTP_FROM) ctx.addIssue({ code: "custom", path: ["SMTP_FROM"], message: "required with SMTP_HOST" });
  });

export interface SmtpConfig {
  host: string;
  port: number;
  secure: boolean;
  user: string | null;
  password: string | null;
  from: string;
}

export interface AppConfig {
  env: "development" | "test" | "production";
  databaseUrl: string;
  victoriaMetricsUrl: string;
  publicUrl: string;
  /** Origin derived from PUBLIC_URL; the realtime gateway requires an exact match. */
  publicOrigin: string;
  agentUrl: string;
  listenHost: string;
  listenPort: number;
  dataDir: string;
  /** Raw env value; resolved into bytes by `loadMasterKey`. */
  masterKeyBase64: string | null;
  cookieSecure: boolean;
  logLevel: string;
  trustProxy: boolean | number | string[];
  pgBossSchema: string;
  webDistDir: string | null;
  smtp: SmtpConfig | null;
  agent: {
    heartbeatIntervalMs: number;
    metricsIntervalMs: number;
    offlineAfterMs: number;
    sweepIntervalMs: number;
    maxQueuedBytes: number;
  };
  alertEvalIntervalMs: number;
  metricsFlushIntervalMs: number;
  apiKeyRateLimitPerMin: number;
  schedulerIntervalMs: number;
}

export class ConfigError extends Error {
  constructor(readonly issues: string[]) {
    super(`Invalid configuration:\n  ${issues.join("\n  ")}`);
    this.name = "ConfigError";
  }
}

export function loadConfig(source: NodeJS.ProcessEnv = process.env, cwd = process.cwd()): AppConfig {
  // Treat empty strings as unset so `FOO=` in an env file behaves like an absent variable.
  const cleaned = Object.fromEntries(Object.entries(source).filter(([, v]) => v !== undefined && v !== ""));
  const parsed = EnvSchema.safeParse(cleaned);
  if (!parsed.success) {
    throw new ConfigError(parsed.error.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`));
  }
  const e = parsed.data;
  const publicUrl = e.PUBLIC_URL.replace(/\/+$/, "");
  const smtp: SmtpConfig | null = e.SMTP_HOST
    ? {
        host: e.SMTP_HOST,
        port: e.SMTP_PORT ?? (e.SMTP_SECURE ? 465 : 587),
        secure: e.SMTP_SECURE ?? false,
        user: e.SMTP_USER ?? null,
        password: e.SMTP_PASSWORD ?? null,
        from: e.SMTP_FROM ?? "",
      }
    : null;
  return {
    env: e.NODE_ENV,
    databaseUrl: e.DATABASE_URL ?? DEV_DATABASE_URL,
    victoriaMetricsUrl: (e.VICTORIA_METRICS_URL ?? DEV_VICTORIA_METRICS_URL).replace(/\/+$/, ""),
    publicUrl,
    publicOrigin: originOf(publicUrl),
    agentUrl: (e.AGENT_URL ?? publicUrl).replace(/\/+$/, ""),
    listenHost: e.LISTEN_HOST,
    listenPort: e.LISTEN_PORT,
    dataDir: isAbsolute(e.DATA_DIR) ? e.DATA_DIR : resolve(cwd, e.DATA_DIR),
    masterKeyBase64: e.BLOCKFORGE_MASTER_KEY ?? null,
    cookieSecure: e.COOKIE_SECURE ?? publicUrl.startsWith("https://"),
    logLevel: e.LOG_LEVEL,
    trustProxy: e.TRUST_PROXY,
    pgBossSchema: e.PGBOSS_SCHEMA,
    webDistDir: e.WEB_DIST_DIR ? (isAbsolute(e.WEB_DIST_DIR) ? e.WEB_DIST_DIR : resolve(cwd, e.WEB_DIST_DIR)) : null,
    smtp,
    agent: {
      heartbeatIntervalMs: e.AGENT_HEARTBEAT_INTERVAL_MS,
      metricsIntervalMs: e.AGENT_METRICS_INTERVAL_MS,
      offlineAfterMs: e.NODE_OFFLINE_AFTER_MS,
      sweepIntervalMs: e.NODE_SWEEP_INTERVAL_MS,
      maxQueuedBytes: e.AGENT_MAX_QUEUED_BYTES,
    },
    alertEvalIntervalMs: e.ALERT_EVAL_INTERVAL_MS,
    metricsFlushIntervalMs: e.METRICS_FLUSH_INTERVAL_MS,
    apiKeyRateLimitPerMin: e.API_KEY_RATE_LIMIT_PER_MIN,
    schedulerIntervalMs: e.SCHEDULER_INTERVAL_MS,
  };
}
