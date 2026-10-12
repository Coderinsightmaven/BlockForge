/**
 * Contract-valid objects for unit tests only. Never imported by application code.
 */
import { Me, Node } from "@blockforge/contracts";
import type { Me as MeT, Node as NodeT, Permission } from "@blockforge/contracts";

export const USER_ID = "11111111-1111-4111-8111-111111111111";
export const NODE_ID = "22222222-2222-4222-8222-222222222222";

export function makeMe(
  opts: { permissions?: Permission[]; mfaEnabled?: boolean; mfaVerified?: boolean; csrfToken?: string } = {},
): MeT {
  return Me.parse({
    user: {
      id: USER_ID,
      email: "owner@example.test",
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
