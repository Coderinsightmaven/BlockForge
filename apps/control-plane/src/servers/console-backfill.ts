import { AGENT_LIMITS } from "@blockforge/contracts";
import { eq } from "drizzle-orm";
import type { Logger } from "pino";
import type { ConsoleBuffers } from "../agents/console-buffer.js";
import { AgentCommandError, type AgentGateway } from "../agents/gateway.js";
import type { Db } from "../db/client.js";
import { servers } from "../db/schema/index.js";
import { maskSecrets } from "./secret-masks.js";

export const BACKFILL_MAX_LINES = 500;

/**
 * After a control-plane restart the console ring buffers are empty while the agent still holds the
 * recent output. The first history request (or `console:` subscription) for an installed server with
 * an empty buffer pulls `workload.logs.tail` once, masks secret variable values like live output and
 * appends it with fresh seqs. The marker lives on the buffer, so a pruned buffer may backfill again.
 */
export class ConsoleBackfill {
  private readonly inflight = new Map<string, Promise<void>>();

  constructor(
    private readonly d: {
      db: Db;
      gateway: AgentGateway;
      consoles: ConsoleBuffers;
      masks: { forServer(serverId: string): Promise<readonly string[]> };
      logger: Logger;
    },
  ) {}

  ensure(serverId: string, lines = BACKFILL_MAX_LINES): Promise<void> {
    if (this.d.consoles.isBackfilled(serverId)) return Promise.resolve();
    if (this.d.consoles.tail(serverId, 1).lines.length) return Promise.resolve();
    let p = this.inflight.get(serverId);
    if (!p) {
      p = this.run(serverId, Math.max(1, Math.min(lines, BACKFILL_MAX_LINES))).finally(() => this.inflight.delete(serverId));
      this.inflight.set(serverId, p);
    }
    return p;
  }

  private async run(serverId: string, n: number): Promise<void> {
    const [s] = await this.d.db.select({ nodeId: servers.nodeId, installedAt: servers.installedAt }).from(servers).where(eq(servers.id, serverId)).limit(1);
    // Only workloads that exist on the agent; an unreachable node is retried on the next request.
    if (!s?.installedAt || !this.d.gateway.isReady(s.nodeId)) return;
    try {
      const r = await this.d.gateway.send(s.nodeId, "workload.logs.tail", { workloadId: serverId, lines: n }, { timeoutMs: 10_000 });
      const secrets = await this.d.masks.forServer(serverId);
      // Live output may have arrived meanwhile: then the buffer is already the better source.
      if (!this.d.consoles.tail(serverId, 1).lines.length && r.lines.length) {
        this.d.consoles.append(
          serverId,
          r.lines.map((l) => ({ ...l, line: maskSecrets(l.line.length > AGENT_LIMITS.logLineMaxBytes ? l.line.slice(0, AGENT_LIMITS.logLineMaxBytes) : l.line, secrets) })),
        );
      }
      this.d.consoles.markBackfilled(serverId);
    } catch (err) {
      if (err instanceof AgentCommandError && err.code === "NOT_FOUND") this.d.consoles.markBackfilled(serverId);
      this.d.logger.debug({ err, serverId }, "console backfill failed");
    }
  }
}
