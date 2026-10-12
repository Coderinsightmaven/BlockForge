import { loadConfig } from "../config/env.js";
import { createLogger } from "../logging/logger.js";
import { createPool } from "./client.js";
import { runMigrations } from "./migrate.js";

const config = loadConfig();
const logger = createLogger(config.logLevel);
const pool = createPool(config.databaseUrl, 2);
try {
  await runMigrations(pool, logger);
} catch (err) {
  logger.fatal({ err }, "migration failed");
  process.exitCode = 1;
} finally {
  await pool.end();
}
