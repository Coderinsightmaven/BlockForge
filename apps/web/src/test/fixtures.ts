/**
 * Contract-valid objects for unit tests only. Never imported by application code.
 */
import {
  Backup,
  DatabaseHost,
  Me,
  Node,
  SERVER_OWNER_PERMISSIONS,
  Schedule,
  Server,
  ServerDatabase,
} from "@blockforge/contracts";
import type {
  Backup as BackupT,
  DatabaseHost as DatabaseHostT,
  Me as MeT,
  Node as NodeT,
  Permission,
  Schedule as ScheduleT,
  Server as ServerT,
  ServerDatabase as ServerDatabaseT,
} from "@blockforge/contracts";

export const USER_ID = "11111111-1111-4111-8111-111111111111";
export const NODE_ID = "22222222-2222-4222-8222-222222222222";

export function makeMe(
  opts: { permissions?: Permission[]; mfaEnabled?: boolean; mfaVerified?: boolean; csrfToken?: string } = {},
): MeT {
  return Me.parse({
    user: {
      id: USER_ID,
      email: "owner@example.test",
      username: "owner",
      displayName: "Test Owner",
      status: "active",
      mfaEnabled: opts.mfaEnabled ?? false,
      lastLoginAt: null,
      createdAt: 1_700_000_000_000,
      roles: [],
    },
    globalPermissions: opts.permissions ?? ["monitoring.view", "nodes.view"],
    scopedPermissions: [],
    session: { mfaVerified: opts.mfaVerified ?? true, expiresAt: 1_900_000_000_000 },
    csrfToken: opts.csrfToken ?? "csrf-from-me",
  });
}

export function makeNode(overrides: Partial<NodeT> = {}): NodeT {
  return Node.parse({
    id: NODE_ID,
    name: "fra-1",
    slug: "fra-1",
    status: "active",
    connection: "online",
    location: null,
    tags: [],
    publicAddress: null,
    privateAddress: null,
    schedulingEnabled: true,
    agentVersion: "0.1.0",
    lastHeartbeatAt: null,
    lastConnectedAt: null,
    clockSkewMs: null,
    facts: null,
    capacity: {
      cpuAllocatableMillicores: 8000,
      memoryAllocatableBytes: 16 * 1024 ** 3,
      storageAllocatableBytes: 100 * 1024 ** 3,
      cpuReservedMillicores: 0,
      memoryReservedBytes: 0,
      storageReservedBytes: 0,
      overcommitMemoryRatio: 1,
    },
    serverCount: 0,
    latest: null,
    createdAt: 1_700_000_000_000,
    ...overrides,
  });
}

export function jsonResponse(
  body: unknown,
  init: { status?: number; headers?: Record<string, string> } = {},
): Response {
  return new Response(body === undefined ? null : JSON.stringify(body), {
    status: init.status ?? 200,
    headers: { "content-type": "application/json", ...init.headers },
  });
}

export function apiErrorBody(code: string, message = "nope", requestId = "req-1", details?: unknown) {
  return { error: { code, message, requestId, ...(details === undefined ? {} : { details }) } };
}

export const SERVER_ID = "55555555-5555-4555-8555-555555555555";
export const TEMPLATE_ID = "66666666-6666-4666-8666-666666666666";

export function makeServer(overrides: Partial<ServerT> = {}): ServerT {
  return Server.parse({
    id: SERVER_ID,
    shortId: "55555555",
    name: "Survival",
    slug: "survival",
    description: "",
    kind: "game",
    ownerId: USER_ID,
    ownerName: "Test Owner",
    templateId: TEMPLATE_ID,
    templateName: "Minecraft: Java Edition",
    templateKind: "minecraft",
    game: "minecraft-java",
    nodeId: NODE_ID,
    nodeName: "fra-1",
    networkId: null,
    software: "paper",
    minecraftVersion: "1.21.4",
    build: "100",
    javaMajor: 21,
    heapMaxBytes: 3 * 1024 ** 3,
    dockerImage: "eclipse-temurin:21-jre",
    state: "running",
    desiredState: "running",
    activeOperation: null,
    activeJobId: null,
    suspended: false,
    memoryLimitBytes: 4 * 1024 ** 3,
    cpuLimitMillicores: 2000,
    storageQuotaBytes: null,
    allocationLimit: 2,
    backupLimit: 3,
    databaseLimit: 2,
    allocations: [],
    address: "play.example.test:25565",
    startup: "auto",
    restartPolicy: { mode: "on-failure", maxRetries: 3, backoffMs: 10000 },
    timezone: "UTC",
    location: null,
    lastStartedAt: null,
    lastCrashAt: null,
    lastExitCode: null,
    lastOomKilled: false,
    createdAt: 1_700_000_000_000,
    latest: null,
    myPermissions: [...SERVER_OWNER_PERMISSIONS],
    sftp: null,
    ...overrides,
  });
}

export const BACKUP_ID = "88888888-8888-4888-8888-888888888888";
export const SCHEDULE_ID = "99999999-9999-4999-8999-999999999999";
export const JOB_ID = "77777777-7777-4777-8777-777777777777";

export function makeBackup(overrides: Partial<BackupT> = {}): BackupT {
  return Backup.parse({
    id: BACKUP_ID,
    serverId: SERVER_ID,
    name: "Before 1.21 update",
    status: "completed",
    locked: false,
    storage: "local",
    consistency: "save-flush",
    sizeBytes: 512 * 1024 ** 2,
    sha256: "a".repeat(64),
    ignored: [],
    skippedSymlinks: 0,
    error: null,
    createdBy: USER_ID,
    createdByName: "owner",
    scheduleId: null,
    jobId: null,
    createdAt: 1_760_000_000_000,
    completedAt: 1_760_000_060_000,
    ...overrides,
  });
}

export function makeSchedule(overrides: Partial<ScheduleT> = {}): ScheduleT {
  return Schedule.parse({
    id: SCHEDULE_ID,
    serverId: SERVER_ID,
    name: "Nightly restart",
    cron: { minute: "0", hour: "4", dayOfMonth: "*", month: "*", dayOfWeek: "*" },
    timezone: "Europe/Berlin",
    enabled: true,
    onlyWhenOnline: false,
    tasks: [
      {
        action: "command",
        command: "say Restarting in 5 minutes",
        offsetSeconds: 0,
        continueOnFailure: true,
      },
      { action: "power", power: "restart", offsetSeconds: 300, continueOnFailure: false },
    ],
    nextRunAt: 1_760_234_400_000,
    lastRunAt: null,
    lastRunStatus: null,
    running: false,
    createdAt: 1_760_000_000_000,
    ...overrides,
  });
}

export const DATABASE_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
export const DATABASE_HOST_ID = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

export function makeServerDatabase(overrides: Partial<ServerDatabaseT> = {}): ServerDatabaseT {
  return ServerDatabase.parse({
    id: DATABASE_ID,
    serverId: SERVER_ID,
    hostId: DATABASE_HOST_ID,
    hostName: "mysql-fra",
    host: "db.example.test",
    port: 3306,
    database: "s55555555_luckperms",
    username: "u55555555_k3j9x0q2ab",
    remote: "%",
    status: "ready",
    createdAt: 1_760_000_000_000,
    passwordRotatedAt: null,
    ...overrides,
  });
}

export function makeDatabaseHost(overrides: Partial<DatabaseHostT> = {}): DatabaseHostT {
  return DatabaseHost.parse({
    id: DATABASE_HOST_ID,
    name: "mysql-fra",
    host: "10.0.0.5",
    port: 3306,
    publicHost: "db.example.test",
    username: "blockforge",
    nodeId: NODE_ID,
    nodeName: "fra-1",
    maxDatabases: 50,
    databaseCount: 3,
    tlsMode: "preferred",
    tlsCaCertificate: null,
    notes: "",
    createdAt: 1_760_000_000_000,
    updatedAt: 1_760_000_000_000,
    ...overrides,
  });
}
