import { randomBytes } from "node:crypto";
import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Logger } from "pino";
import type { AppConfig } from "./env.js";

export const MASTER_KEY_BYTES = 32;

export class MasterKeyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MasterKeyError";
  }
}

export function parseMasterKey(value: string): Buffer {
  const trimmed = value.trim();
  if (!/^[A-Za-z0-9+/_-]+={0,2}$/.test(trimmed)) throw new MasterKeyError("BLOCKFORGE_MASTER_KEY must be base64");
  const key = Buffer.from(trimmed.replace(/-/g, "+").replace(/_/g, "/"), "base64");
  if (key.length !== MASTER_KEY_BYTES) {
    throw new MasterKeyError(`BLOCKFORGE_MASTER_KEY must decode to ${MASTER_KEY_BYTES} bytes (got ${key.length})`);
  }
  return key;
}

/**
 * Resolves the master key: env var first; otherwise (development/test only) a key file in DATA_DIR,
 * generated on first use with mode 0600. Production refuses to auto-generate: losing this key makes
 * every stored secret unrecoverable, so operators must provision and back it up deliberately.
 */
export async function loadMasterKey(config: AppConfig, logger: Logger): Promise<Buffer> {
  if (config.masterKeyBase64) return parseMasterKey(config.masterKeyBase64);
  if (config.env === "production") {
    throw new MasterKeyError("BLOCKFORGE_MASTER_KEY is required in production (32 random bytes, base64)");
  }
  const file = join(config.dataDir, "master.key");
  try {
    const existing = await readFile(file, "utf8");
    return parseMasterKey(existing);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
  }
  await mkdir(config.dataDir, { recursive: true });
  const key = randomBytes(MASTER_KEY_BYTES);
  await writeFile(file, key.toString("base64") + "\n", { mode: 0o600, flag: "wx" });
  await chmod(file, 0o600).catch(() => undefined);
  logger.warn(
    { file },
    "*** GENERATED A DEVELOPMENT MASTER KEY *** BLOCKFORGE_MASTER_KEY is not set, so a random key was written to " +
      `${file}. Every stored secret is encrypted with it. This is for development only — set ` +
      "BLOCKFORGE_MASTER_KEY explicitly (and back it up) for any real installation.",
  );
  return key;
}
