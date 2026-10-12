import { existsSync } from "node:fs";
import { join } from "node:path";
import { AGENT_LIMITS, REQUEST_ID_HEADER } from "@blockforge/contracts";
import fastifyCookie from "@fastify/cookie";
import fastifyHelmet from "@fastify/helmet";
import fastifyRateLimit from "@fastify/rate-limit";
import fastifyStatic from "@fastify/static";
import fastifyWebsocket from "@fastify/websocket";
import Fastify, { type FastifyBaseLogger, type FastifyInstance } from "fastify";
import type pg from "pg";
import type { Logger } from "pino";
import { AgentAuthenticator, RotationCoordinator } from "./agents/authenticator.js";
import { ConsoleBuffers } from "./agents/console-buffer.js";
import { EnrollmentService } from "./agents/enrollment.js";
import { AgentGateway, CLOSE } from "./agents/gateway.js";
import { NodeStateTracker } from "./agents/node-state.js";
import { registerAgentRoutes } from "./agents/routes.js";
import { loadOrCreateSigningKey, signerFromSeed } from "./agents/signing-key.js";
import { TransferBroker } from "./agents/transfers.js";
import { WorkloadOwnership } from "./agents/workload-ownership.js";
import { AlertEvaluator } from "./alerts/evaluator.js";
import { registerAlertRoutes } from "./alerts/routes.js";
import { AlertService } from "./alerts/service.js";
import { registerAuditRoutes } from "./audit/routes.js";
import { AuditService } from "./audit/service.js";
import { registerAuthRoutes } from "./auth/routes.js";
import { AuthService } from "./auth/service.js";
import { SessionService } from "./auth/sessions.js";
import type { AppConfig } from "./config/env.js";
import { loadMasterKey } from "./config/master-key.js";
import type { AppContext } from "./context.js";
import { createDb, createPool } from "./db/client.js";
import { EventBus } from "./events/bus.js";
import { registerAuthHooks } from "./http/auth-hooks.js";
import { errorBody, registerErrorHandling } from "./http/errors.js";
import { registerHealthRoutes } from "./http/health.js";
import { IdempotencyService } from "./http/idempotency.js";
import { genReqId } from "./http/request-id.js";
import "./http/types.js";
import { rotateCredentialsJob } from "./jobs/builtin/rotate-credentials.js";
import { registerJobRoutes } from "./jobs/routes.js";
import { JobRunner } from "./jobs/runner.js";
import type { JobDefinition } from "./jobs/types.js";
import { systemClock, type Clock } from "./lib/clock.js";
import { deriveKey } from "./lib/crypto.js";
import { rateLimited } from "./lib/errors.js";
import { PeriodicTask } from "./lib/periodic.js";
import { createLogger } from "./logging/logger.js";
import { runRetention } from "./maintenance/retention.js";
import { LatestCache } from "./metrics/latest.js";
import { MetricsQueryService } from "./metrics/query.js";
import { registerMetricsRoutes } from "./metrics/routes.js";
import { VmClient } from "./metrics/vm-client.js";
import { VmWriter } from "./metrics/vm-writer.js";
import { registerNodeRoutes } from "./nodes/routes.js";
import { NodesService } from "./nodes/service.js";
import { EmailSender } from "./notifications/adapters.js";
import type { RawPost } from "./notifications/http.js";
import { NotificationService } from "./notifications/service.js";
import type { LookupFn } from "./notifications/ssrf.js";
import { OverviewPublisher } from "./overview/publisher.js";
import { OverviewService } from "./overview/service.js";
import { RbacService } from "./rbac/service.js";
import { registerRealtimeRoutes } from "./realtime/gateway.js";
import { RealtimeHub } from "./realtime/hub.js";
import { SecretBox } from "./secrets/secret-box.js";
import { SecretsService } from "./secrets/service.js";
import { registerSettingsRoutes } from "./settings/routes.js";
import { seedBuiltinTemplates } from "./templates/builtin.js";
import { SettingsService } from "./settings/service.js";
import { registerUserRoutes } from "./users/routes.js";
import { UsersService } from "./users/service.js";
import { registerAccountRoutes } from "./account/routes.js";
import { SshKeysService } from "./account/ssh-keys.js";
import { ApiKeysService } from "./apikeys/service.js";
import { abortStaleUploads, backupJobDefinitions, deleteAllBackups, pruneFailedBackups, retryPendingSaveOn, type BackupJobDeps } from "./backups/jobs.js";
import { registerBackupRoutes } from "./backups/routes.js";
import { BackupsService } from "./backups/service.js";
import { BackupStorage } from "./backups/storage.js";
import { registerScheduleRoutes } from "./schedules/routes.js";
import { Scheduler } from "./schedules/scheduler.js";
import { SchedulesService } from "./schedules/service.js";
import { registerAllocationRoutes } from "./allocations/routes.js";
import { AllocationsService } from "./allocations/service.js";
import { CatalogService } from "./catalog/service.js";
import type { Catalog } from "@blockforge/minecraft";
import { BrowserTransfers } from "./files/browser-transfers.js";
import { registerFileRoutes } from "./files/routes.js";
import { FilesService } from "./files/service.js";
import { ServerAccessService } from "./servers/access.js";
import { serverJobDefinitions } from "./servers/jobs.js";
import { ServerReconciler } from "./servers/reconciler.js";
import { registerServerRoutes } from "./servers/routes.js";
import { ServersService } from "./servers/service.js";
import { ServerStateService } from "./servers/state.js";
import { ConsoleSecretMasks } from "./servers/secret-masks.js";
import { ConsoleBackfill } from "./servers/console-backfill.js";
import { SftpService } from "./sftp/service.js";
import { registerTemplateRoutes } from "./templates/routes.js";
import { TemplatesService } from "./templates/service.js";


export interface BuildAppOptions {
  config: AppConfig;
  logger?: Logger;
  clock?: Clock;
  /** Use an existing pool (tests); otherwise one is created and closed with the app. */
  pool?: pg.Pool;
  masterKey?: Buffer;
  /** Deterministic control-plane signing key (tests only). */
  signingKeySeed?: Uint8Array;
  /** Receives the one-time setup token (default: printed once to the log). */
  setupTokenSink?: (token: string) => void;
  /** Start pg-boss workers and periodic tasks (default true). */
  startBackground?: boolean;
  /** Test seams for outbound webhooks (DNS + HTTPS transport). */
  notifications?: { lookup?: LookupFn; transport?: RawPost };
  /** How long the rotation job waits for the agent to reconnect with its new key. */
  rotationConfirmTimeoutMs?: number;
  /** Additional job types (tests exercise the runner with them). Input types vary per job, hence `any`. */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  extraJobs?: JobDefinition<any>[];
  /** Test seams for the software catalogue (adapter overrides, transport, DNS). */
  catalog?: { adapters?: Partial<Catalog>; fetchImpl?: typeof fetch; lookup?: LookupFn; ttlMs?: number };
  /** Scheduler test seams (task offsets). */
  scheduler?: { sleep?: (ms: number, signal: AbortSignal) => Promise<void> };
  /** Server job timing (tests shorten the readiness wait). */
  serverJobs?: { readyTimeoutMs?: number; slpWaitMs?: number; installTimeoutMs?: number; saveTimeoutMs?: number; saveToggleTimeoutMs?: number };
}

export interface BuiltApp {
  app: FastifyInstance;
  ctx: AppContext;
  tasks: Record<string, PeriodicTask>;
}

function defaultSetupTokenSink(logger: Logger): (token: string) => void {
  return (token) => {
    logger.warn(
      { setupToken: "[see message]" },
      [
        "",
        "================================================================================",
        " BlockForge first-run setup",
        " No owner account exists yet. Open the web UI and enter this one-time setup token:",
        "",
        `     ${token}`,
        "",
        " The token is valid until setup completes; a new one is printed on every restart.",
        "================================================================================",
      ].join("\n"),
    );
  };
}

/** Strict CSP for the SPA served from the same origin (no inline scripts, no third-party origins). */
function cspDirectives(publicUrl: string) {
  const ws = publicUrl.replace(/^http/, "ws");
  return {
    defaultSrc: ["'self'"],
    scriptSrc: ["'self'"],
    // Radix/React set inline `style` attributes; script execution stays locked down.
    styleSrc: ["'self'", "'unsafe-inline'"],
    imgSrc: ["'self'", "data:", "blob:"],
    fontSrc: ["'self'", "data:"],
    connectSrc: ["'self'", ws],
    objectSrc: ["'none'"],
    baseUri: ["'self'"],
    formAction: ["'self'"],
    frameAncestors: ["'none'"],
    workerSrc: ["'self'", "blob:"],
    upgradeInsecureRequests: publicUrl.startsWith("https://") ? [] : null,
  };
}

export async function buildApp(opts: BuildAppOptions): Promise<BuiltApp> {
  const { config } = opts;
  const logger = opts.logger ?? createLogger(config.logLevel);
  const clock = opts.clock ?? systemClock;
  const ownPool = !opts.pool;
  const pool = opts.pool ?? createPool(config.databaseUrl);
  const db = createDb(pool);
  const masterKey = opts.masterKey ?? (await loadMasterKey(config, logger));

  // --- Services --------------------------------------------------------------------
  const box = new SecretBox(masterKey);
  const secrets = new SecretsService(db, box);
  const settings = new SettingsService(db);
  const audit = new AuditService(db, clock);
  const bus = new EventBus(db, clock, logger.child({ module: "events" }));
  const hub = new RealtimeHub(clock, logger.child({ module: "realtime" }));
  const rbac = new RbacService(db, logger);
  const sessions = new SessionService(db, clock, deriveKey(masterKey, "csrf"), logger);
  const users = new UsersService(db, rbac, audit, sessions);
  const auth = new AuthService(db, clock, sessions, rbac, users, audit, box, logger.child({ module: "auth" }));
  const idempotency = new IdempotencyService(db, clock);
  const signer = opts.signingKeySeed ? signerFromSeed(opts.signingKeySeed) : await loadOrCreateSigningKey(secrets, logger);

  const latest = new LatestCache(clock, config.agent.metricsIntervalMs);
  const vmWriter = new VmWriter({ url: config.victoriaMetricsUrl, clock, logger: logger.child({ module: "vm-writer" }) });
  const vmClient = new VmClient(config.victoriaMetricsUrl);
  const metricsQuery = new MetricsQueryService(vmClient);
  const consoles = new ConsoleBuffers();
  const ownership = new WorkloadOwnership(db, clock);
  const transfers = new TransferBroker();
  const masks = new ConsoleSecretMasks(db, clock);
  const rotations = new RotationCoordinator();
  const authenticator = new AgentAuthenticator(db, clock, rotations, logger.child({ module: "agent-auth" }));

  const gateway = new AgentGateway({
    db,
    clock,
    logger: logger.child({ module: "agent-gateway" }),
    signer,
    latest,
    vm: vmWriter,
    hub,
    consoles,
    ownership,
    bus,
    heartbeatIntervalMs: config.agent.heartbeatIntervalMs,
    metricsIntervalMs: config.agent.metricsIntervalMs,
    maxQueuedBytes: config.agent.maxQueuedBytes,
    masks,
  });
  const tracker = new NodeStateTracker(
    db,
    clock,
    logger.child({ module: "node-state" }),
    { heartbeatIntervalMs: config.agent.heartbeatIntervalMs, offlineAfterMs: config.agent.offlineAfterMs },
    (nodeId) => gateway.isReady(nodeId),
  );
  gateway.setTracker(tracker);
  await tracker.load();

  const enrollment = new EnrollmentService(
    db,
    clock,
    audit,
    bus,
    tracker,
    signer.publicKey,
    { agentUrl: config.agentUrl, heartbeatIntervalMs: config.agent.heartbeatIntervalMs, metricsIntervalMs: config.agent.metricsIntervalMs },
    logger.child({ module: "enrollment" }),
  );
  const nodes = new NodesService(db, clock, tracker, gateway, latest, audit, bus, hub, logger.child({ module: "nodes" }));
  const jobs = new JobRunner(db, clock, bus, hub, logger.child({ module: "jobs" }), {
    databaseUrl: config.databaseUrl,
    schema: config.pgBossSchema,
  });
  jobs.define(rotateCredentialsJob({ db, clock, gateway, rotations, audit, ...(opts.rotationConfirmTimeoutMs ? { confirmTimeoutMs: opts.rotationConfirmTimeoutMs } : {}) }));
  for (const def of opts.extraJobs ?? []) jobs.define(def as JobDefinition<unknown>);
  const overview = new OverviewService(db, clock, rbac, tracker, latest);
  const overviewPublisher = new OverviewPublisher(hub, overview, clock, logger.child({ module: "overview" }));
  const notifications = new NotificationService({
    db,
    clock,
    secrets,
    settings,
    audit,
    email: new EmailSender(config.smtp),
    logger: logger.child({ module: "notifications" }),
    ...(opts.notifications?.lookup ? { lookup: opts.notifications.lookup } : {}),
    ...(opts.notifications?.transport ? { transport: opts.notifications.transport } : {}),
  });
  const alerts = new AlertService(db, clock, audit, bus, hub, rbac, notifications, logger.child({ module: "alerts" }));
  const alertEvaluator = new AlertEvaluator(db, clock, tracker, latest, alerts, notifications, bus, logger.child({ module: "alert-evaluator" }));

  const templates = new TemplatesService(db, clock, audit);
  const catalog = new CatalogService({
    logger: logger.child({ module: "catalog" }),
    ...(opts.catalog?.adapters ? { catalog: opts.catalog.adapters } : {}),
    ...(opts.catalog?.fetchImpl ? { fetchImpl: opts.catalog.fetchImpl } : {}),
    ...(opts.catalog?.lookup ? { lookup: opts.catalog.lookup } : {}),
    ...(opts.catalog?.ttlMs !== undefined ? { ttlMs: opts.catalog.ttlMs } : {}),
  });
  const allocations = new AllocationsService(db, gateway, audit, logger.child({ module: "allocations" }));
  const serverAccess = new ServerAccessService(db, audit);
  const serverState = new ServerStateService(db, clock, bus, logger.child({ module: "server-state" }));
  const reconciler = new ServerReconciler(db, clock, serverState, bus, logger.child({ module: "reconciler" }));
  const servers = new ServersService({
    db, clock, logger: logger.child({ module: "servers" }), audit, bus, hub, tracker, gateway, latest, consoles, ownership, jobs, catalog, templates,
    access: serverAccess, state: serverState, masks,
  });
  templates.onChange(() => masks.invalidate());
  const browserTransfers = new BrowserTransfers(clock);
  const files = new FilesService({ gateway, audit, templates, transfers, browser: browserTransfers, jobs, logger: logger.child({ module: "files" }) });
  const sshKeys = new SshKeysService(db, audit);
  const apiKeys = new ApiKeysService(db, clock, rbac, audit, logger.child({ module: "api-keys" }), config.apiKeyRateLimitPerMin);
  const sftp = new SftpService(db, clock, rbac, audit, logger.child({ module: "sftp" }));
  const backupStorage = new BackupStorage(settings, secrets, db);
  const backupsService = new BackupsService({
    db, clock, logger: logger.child({ module: "backups" }), audit, hub, gateway, jobs, storage: backupStorage, access: serverAccess, state: serverState,
    browser: browserTransfers, transfers,
  });
  const backupDeps: BackupJobDeps = {
    db, clock, logger: logger.child({ module: "backup-jobs" }), gateway, latest, consoles, ownership, state: serverState, bus, audit, masks,
    storage: backupStorage, publish: (id) => backupsService.publish(id), publishDeleted: (s, b) => backupsService.publishDeleted(s, b),
    ...(opts.serverJobs ?? {}),
  };
  for (const def of serverJobDefinitions({
    db, clock, logger: logger.child({ module: "server-jobs" }), gateway, latest, consoles, ownership, state: serverState, bus, audit, masks,
    deleteBackups: (serverId, c) => deleteAllBackups(backupDeps, serverId, c),
    ...(opts.serverJobs ?? {}),
  })) {
    jobs.define(def as JobDefinition<unknown>);
  }
  for (const def of backupJobDefinitions(backupDeps)) jobs.define(def as JobDefinition<unknown>);
  const consoleBackfill = new ConsoleBackfill({ db, gateway, consoles, masks, logger: logger.child({ module: "console-backfill" }) });
  let schedulesService: SchedulesService | null = null;
  const scheduler = new Scheduler({
    db, clock, logger: logger.child({ module: "scheduler" }), bus, rbac, access: serverAccess, servers, backups: backupsService, jobs,
    schedules: () => schedulesService!,
    ...(opts.scheduler?.sleep ? { sleep: opts.scheduler.sleep } : {}),
  });
  schedulesService = new SchedulesService({ db, clock, logger: logger.child({ module: "schedules" }), audit, hub, access: serverAccess, execute: (id) => scheduler.execute(id), lease: () => scheduler.lease() });
  for (const def of files.jobDefinitions()) jobs.define(def as JobDefinition<unknown>);

  const ctx: AppContext = {
    config, logger, clock, pool, db, box, secrets, settings, audit, bus, hub, rbac, sessions, auth, users, idempotency, jobs,
    signer, authenticator, rotations, tracker, gateway, enrollment, ownership, consoles, transfers, nodes, latest, vmWriter,
    vmClient, metricsQuery, overview, overviewPublisher, alerts, alertEvaluator, notifications,
    templates, catalog, allocations, serverAccess, serverState, servers, reconciler, files, browserTransfers, sshKeys, apiKeys, sftp, backups: backupsService, backupStorage, backupJobs: backupDeps, schedules: schedulesService, scheduler, consoleBackfill,
  };

  // --- Seed & wiring -------------------------------------------------------------------
  await rbac.seedBuiltinRoles();
  await seedBuiltinTemplates(db);
  await alerts.seedDefaults();
  alertEvaluator.subscribe();
  tracker.onChange(async (change, node) => {
    await bus.publish({
      type: "node.connection.changed",
      subjectType: "node",
      subjectId: change.nodeId,
      data: { from: change.from, to: change.to, name: node.name },
    });
    await nodes.publishUpdated(change.nodeId);
    overviewPublisher.markDirty();
  });
  gateway.on("nodeMetrics", () => overviewPublisher.markDirty());
  gateway.on("sessionReady", (nodeId) => {
    void nodes.publishUpdated(nodeId);
    // A reconnected node may host servers still waiting for `save-on`.
    setTimeout(() => void retryPendingSaveOn(backupDeps, nodeId).catch((err: unknown) => logger.warn({ err, nodeId }, "save-on retry failed")), 500).unref();
  });
  reconciler.attach(gateway, tracker);
  serverState.onChange((serverId) => {
    void servers.publishUpdated(serverId);
    overviewPublisher.markDirty();
  });
  gateway.on("sftpActivity", (nodeId, ev) => void sftp.recordActivity(nodeId, ev).catch((err: unknown) => logger.warn({ err }, "sftp activity not recorded")));
  bus.subscribe("job.updated", () => overviewPublisher.markDirty());
  bus.subscribe("alert.fired", () => overviewPublisher.markDirty());
  bus.subscribe("alert.resolved", () => overviewPublisher.markDirty());

  // --- HTTP -----------------------------------------------------------------------
  const app = Fastify({
    loggerInstance: logger as FastifyBaseLogger,
    genReqId,
    trustProxy:
      typeof config.trustProxy === "number"
        ? ((hops: number) => (_addr: string, hop: number) => hop < hops)(config.trustProxy)
        : config.trustProxy,
    bodyLimit: 1024 * 1024,
    return503OnClosing: true,
    routerOptions: { ignoreTrailingSlash: true },
  });
  app.addHook("onRequest", async (req, reply) => {
    reply.header(REQUEST_ID_HEADER, req.id);
  });
  // Close agent sessions with "service restart" before the websocket plugin closes the rest.
  app.addHook("preClose", async () => {
    gateway.closeAll(CLOSE.serviceRestart, "control plane restarting");
    for (const c of hub.allClients()) hub.unregister(c);
  });
  await app.register(fastifyHelmet, {
    contentSecurityPolicy: { useDefaults: false, directives: cspDirectives(config.publicUrl) },
    crossOriginEmbedderPolicy: false,
    hsts: config.publicUrl.startsWith("https://") ? { maxAge: 31_536_000, includeSubDomains: true } : false,
    referrerPolicy: { policy: "no-referrer" },
  });
  await app.register(fastifyCookie);
  await app.register(fastifyRateLimit, {
    global: false,
    // Thrown by the plugin; an AppError so the central handler renders the ApiError body.
    errorResponseBuilder: (_req, rl) => rateLimited(rl.ttl / 1000),
  });
  await app.register(fastifyWebsocket, { options: { maxPayload: AGENT_LIMITS.maxFrameBytes } });
  registerErrorHandling(app);
  registerHealthRoutes(app, ctx);

  await app.register(
    async (api) => {
      registerAuthHooks(api, { sessions, rbac, cookieSecure: config.cookieSecure, publicOrigin: config.publicOrigin, apiKeys });
      registerAuthRoutes(api, ctx);
      registerUserRoutes(api, ctx);
      registerAuditRoutes(api, ctx);
      registerNodeRoutes(api, ctx);
      registerJobRoutes(api, ctx);
      registerMetricsRoutes(api, ctx);
      registerAlertRoutes(api, ctx);
      registerSettingsRoutes(api, ctx);
      registerTemplateRoutes(api, ctx);
      registerAllocationRoutes(api, ctx);
      registerServerRoutes(api, ctx);
      registerFileRoutes(api, ctx);
      registerBackupRoutes(api, ctx);
      registerScheduleRoutes(api, ctx);
      registerAccountRoutes(api, ctx);
      registerRealtimeRoutes(api, ctx);
    },
    { prefix: "/api/v1" },
  );
  await app.register(async (agentApi) => registerAgentRoutes(agentApi, ctx), { prefix: "/agent/v1" });

  if (config.webDistDir && existsSync(join(config.webDistDir, "index.html"))) {
    await app.register(fastifyStatic, { root: config.webDistDir, wildcard: false, index: ["index.html"] });
    app.setNotFoundHandler((req, reply) => {
      const path = req.url.split("?")[0] ?? "/";
      if (req.method === "GET" && !path.startsWith("/api/") && !path.startsWith("/agent/")) {
        return reply.type("text/html").sendFile("index.html");
      }
      return reply.status(404).send(errorBody(req, "NOT_FOUND", `Route ${req.method} ${path} not found`));
    });
  }

  // --- Background ----------------------------------------------------------------------
  const tasks: Record<string, PeriodicTask> = {
    nodeSweep: new PeriodicTask("node-sweep", config.agent.sweepIntervalMs, () => tracker.sweep(), logger),
    alertEval: new PeriodicTask("alert-eval", config.alertEvalIntervalMs, () => alertEvaluator.evaluate(), logger),
    scheduler: new PeriodicTask("scheduler", config.schedulerIntervalMs, async () => void (await scheduler.tick()), logger),
    metricsFlush: new PeriodicTask("metrics-flush", config.metricsFlushIntervalMs, () => vmWriter.flush(), logger),
    outbox: new PeriodicTask("event-outbox", 10_000, async () => void (await bus.redispatchPending()), logger),
    deliveries: new PeriodicTask("notification-retries", 15_000, () => notifications.processPending(), logger),
    maintenance: new PeriodicTask(
      "maintenance",
      60_000,
      async () => {
        await authenticator.prune();
        await sessions.pruneExpired();
        await idempotency.prune();
        await runRetention({ db, clock, latest, consoles });
        await scheduler.prune();
        await pruneFailedBackups(backupDeps);
        await abortStaleUploads(backupDeps);
        await retryPendingSaveOn(backupDeps);
        await apiKeys.pruneUsage();
      },
      logger,
    ),
  };

  await auth.ensureSetupToken(opts.setupTokenSink ?? defaultSetupTokenSink(logger));

  const startBackground = opts.startBackground ?? true;
  if (startBackground) {
    await jobs.start();
    await scheduler.recover();
    // Multipart uploads of jobs that died with the previous process; save-on still owed to servers.
    await abortStaleUploads(backupDeps).catch((err: unknown) => logger.warn({ err }, "aborting stale uploads failed"));
    void retryPendingSaveOn(backupDeps).catch((err: unknown) => logger.warn({ err }, "save-on retry failed"));
    for (const t of Object.values(tasks)) t.start();
  }

  app.addHook("onClose", async () => {
    for (const t of Object.values(tasks)) await t.stop();
    overviewPublisher.stop();
    await scheduler.stop();
    if (startBackground) await jobs.stop();
    await vmWriter.flush(true);
    if (ownPool) await pool.end();
  });

  return { app, ctx, tasks };
}
