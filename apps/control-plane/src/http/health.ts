import type { FastifyInstance } from "fastify";
import type { AppContext } from "../context.js";
import { migrationStatus } from "../db/migrate.js";
import { errorMessage } from "../lib/errors.js";

interface Component {
  ok: boolean;
  error?: string;
  [k: string]: unknown;
}

/** `/healthz` (liveness) and `/readyz` (DB, migrations, VictoriaMetrics). No auth, no secrets. */
export function registerHealthRoutes(app: FastifyInstance, ctx: AppContext): void {
  app.get("/healthz", async () => ({ status: "ok" }));

  app.get("/readyz", async (_req, reply) => {
    const components: Record<string, Component> = {};
    try {
      await ctx.pool.query("SELECT 1");
      components.database = { ok: true };
    } catch (err) {
      components.database = { ok: false, error: errorMessage(err) };
    }
    if (components.database?.ok) {
      try {
        const m = await migrationStatus(ctx.pool);
        components.migrations = { ok: m.upToDate, applied: m.applied, expected: m.expected };
      } catch (err) {
        components.migrations = { ok: false, error: errorMessage(err) };
      }
    } else {
      components.migrations = { ok: false, error: "database unavailable" };
    }
    const vmOk = await ctx.vmClient.health();
    components.victoriaMetrics = { ok: vmOk, ...(vmOk ? {} : { error: "unreachable" }), queuedLines: ctx.vmWriter.pendingLines };
    const ready = Object.values(components).every((c) => c.ok);
    return reply.status(ready ? 200 : 503).send({ status: ready ? "ready" : "unavailable", components });
  });
}
