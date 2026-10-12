import { buildApp } from "./app.js";
import { ConfigError, loadConfig } from "./config/env.js";
import { createPool } from "./db/client.js";
import { runMigrations } from "./db/migrate.js";
import { createLogger } from "./logging/logger.js";

async function main(): Promise<void> {
  let config;
  try {
    config = loadConfig();
  } catch (err) {
    if (err instanceof ConfigError) {
      console.error(err.message);
      process.exit(2);
    }
    throw err;
  }
  const logger = createLogger(config.logLevel);
  const pool = createPool(config.databaseUrl);
  await runMigrations(pool, logger);
  const { app } = await buildApp({ config, logger, pool });

  let shuttingDown = false;
  const shutdown = async (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info({ signal }, "shutting down");
    const force = setTimeout(() => {
      logger.error("graceful shutdown timed out; exiting");
      process.exit(1);
    }, 30_000);
    force.unref();
    try {
      await app.close();
      await pool.end();
      logger.info("shutdown complete");
      process.exit(0);
    } catch (err) {
      logger.error({ err }, "error during shutdown");
      process.exit(1);
    }
  };
  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));

  await app.listen({ host: config.listenHost, port: config.listenPort });
}

main().catch((err) => {
  console.error("fatal:", err);
  process.exit(1);
});
