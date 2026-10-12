export const TEST_DATABASE_URL =
  process.env.TEST_DATABASE_URL ?? "postgres://blockforge:blockforge-dev-only@127.0.0.1:55432/blockforge_test";
export const TEST_VICTORIA_METRICS_URL = process.env.TEST_VICTORIA_METRICS_URL ?? "http://127.0.0.1:58428";
export const TEST_PUBLIC_URL = "http://127.0.0.1:5173";
export const TEST_PGBOSS_SCHEMA = "pgboss_test";
