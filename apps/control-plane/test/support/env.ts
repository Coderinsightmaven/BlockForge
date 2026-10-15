export const TEST_DATABASE_URL =
  process.env.TEST_DATABASE_URL ?? "postgres://blockforge:blockforge-dev-only@127.0.0.1:55432/blockforge_test";
export const TEST_VICTORIA_METRICS_URL = process.env.TEST_VICTORIA_METRICS_URL ?? "http://127.0.0.1:58428";
export const TEST_PUBLIC_URL = "http://127.0.0.1:5173";
export const TEST_PGBOSS_SCHEMA = "pgboss_test";
/** MySQL-compatible database hosts from infra/compose (root account, dev-only password). */
export const TEST_MARIADB = {
  host: process.env.TEST_MARIADB_HOST ?? "127.0.0.1",
  port: Number(process.env.TEST_MARIADB_PORT ?? 53306),
  user: "root",
  password: process.env.TEST_MARIADB_PASSWORD ?? "blockforge-dev-only",
};
export const TEST_MYSQL = {
  host: process.env.TEST_MYSQL_HOST ?? "127.0.0.1",
  port: Number(process.env.TEST_MYSQL_PORT ?? 53307),
  user: "root",
  password: process.env.TEST_MYSQL_PASSWORD ?? "blockforge-dev-only",
};
/** MinIO from infra/compose (HTTPS, self-signed: trusted via NODE_EXTRA_CA_CERTS in global setup). */
export const TEST_S3 = {
  endpoint: process.env.TEST_S3_ENDPOINT ?? "https://127.0.0.1:59000",
  region: "us-east-1",
  accessKeyId: process.env.TEST_S3_ACCESS_KEY ?? "blockforge",
  secretAccessKey: process.env.TEST_S3_SECRET_KEY ?? "blockforge-dev-only",
};
