import { AGENT_LIMITS, type NodeConnection, type NodeStatus } from "@blockforge/contracts";

/** Clock skew beyond this marks a connected node `degraded` (token/command expiry would misbehave). */
export const MAX_HEALTHY_CLOCK_SKEW_MS = 30_000;

export interface ConnectionInputs {
  status: NodeStatus;
  /** A WebSocket session exists and completed `hello`. */
  sessionReady: boolean;
  lastHeartbeatAt: number | null;
  lastConnectedAt: number | null;
  lastDisconnectedAt: number | null;
  /** The last session ended with a normal close (1000/1001). */
  lastDisconnectClean: boolean;
  clockSkewMs: number | null;
  /** Container runtime health from facts; null when facts are unknown. */
  runtimeHealthy: boolean | null;
  now: number;
  heartbeatIntervalMs: number;
  offlineAfterMs: number;
}

/**
 * Node connection state machine:
 *  - online:      session ready, heartbeats on time, runtime healthy, clock skew ≤ 30 s
 *  - degraded:    session ready but the container runtime is unhealthy/missing or the clock is skewed
 *  - unreachable: 3 missed heartbeats, or the session dropped (unclean, or clean < offlineAfterMs ago)
 *  - offline:     never connected, revoked, or cleanly disconnected for longer than offlineAfterMs
 */
export function deriveConnection(i: ConnectionInputs): NodeConnection {
  if (i.status === "revoked") return "offline";
  if (i.sessionReady) {
    const last = i.lastHeartbeatAt ?? i.lastConnectedAt ?? i.now;
    if (i.now - last > AGENT_LIMITS.missedHeartbeatsBeforeUnreachable * i.heartbeatIntervalMs) return "unreachable";
    if (i.runtimeHealthy === false) return "degraded";
    if (i.clockSkewMs !== null && Math.abs(i.clockSkewMs) > MAX_HEALTHY_CLOCK_SKEW_MS) return "degraded";
    return "online";
  }
  if (i.lastConnectedAt === null) return "offline";
  if (i.lastDisconnectClean && i.lastDisconnectedAt !== null && i.now - i.lastDisconnectedAt > i.offlineAfterMs) {
    return "offline";
  }
  return "unreachable";
}
