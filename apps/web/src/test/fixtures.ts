/**
 * Contract-valid objects for unit tests only. Never imported by application code.
 */
import { Me, Node, SERVER_OWNER_PERMISSIONS, Server } from "@blockforge/contracts";
import type { Me as MeT, Node as NodeT, Permission, Server as ServerT } from "@blockforge/contracts";

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
    allocations: [],
    address: "play.example.test:25565",
    startup: "auto",
    restartPolicy: { mode: "on-failure", maxRetries: 3, backoffMs: 10000 },
    timezone: "UTC",
    location: null,
    lastStartedAt: null,
    lastCrashAt: null,
    lastExitCode: null,
    createdAt: 1_700_000_000_000,
    latest: null,
    myPermissions: [...SERVER_OWNER_PERMISSIONS],
    sftp: null,
    ...overrides,
  });
}
