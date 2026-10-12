import { generateKeyPairSync, type KeyObject } from "node:crypto";
import type { Logger } from "pino";
import { b64url, ed25519PrivateKeyFromSeed, ed25519RawPublicKey, ed25519SeedFromPrivateKey, fromB64url } from "../lib/crypto.js";
import type { SecretsService } from "../secrets/service.js";

const SECRET_NAME = "control-plane.signing-key";
const SCOPE = { scopeType: "global" as const, scopeId: null };

export interface ControlPlaneSigner {
  /** Raw Ed25519 public key (base64url) that agents pin at enrollment. */
  publicKey: string;
  privateKey: KeyObject;
}

export function signerFromSeed(seed: Uint8Array): ControlPlaneSigner {
  const privateKey = ed25519PrivateKeyFromSeed(seed);
  return { privateKey, publicKey: ed25519RawPublicKey(privateKey) };
}

/**
 * The control-plane command-signing key. Storage decision: the Ed25519 seed is kept in the
 * `secrets` table, AES-256-GCM encrypted with the master key — not as a file in DATA_DIR — so it
 * survives host rebuilds as long as the database and master key are backed up, and so that future
 * control-plane replicas share one key. Generated on first boot; a unique constraint makes
 * concurrent first boots converge on a single key.
 */
export async function loadOrCreateSigningKey(secrets: SecretsService, logger: Logger): Promise<ControlPlaneSigner> {
  const existingId = await secrets.findIdByName(SCOPE, SECRET_NAME);
  if (existingId) return fromStored(await readStored(secrets, existingId));
  const { privateKey } = generateKeyPairSync("ed25519");
  const seed = ed25519SeedFromPrivateKey(privateKey);
  try {
    await secrets.create(SCOPE, SECRET_NAME, b64url(seed));
    logger.info({ publicKey: ed25519RawPublicKey(privateKey) }, "generated control-plane command signing key");
    return signerFromSeed(seed);
  } catch (err) {
    // Lost a race with another starting instance: use the stored key.
    const id = await secrets.findIdByName(SCOPE, SECRET_NAME);
    if (!id) throw err;
    return fromStored(await readStored(secrets, id));
  }
}

async function readStored(secrets: SecretsService, id: string): Promise<string | null> {
  try {
    return await secrets.read(id);
  } catch (err) {
    throw new Error(
      "The stored control-plane signing key cannot be decrypted with the current BLOCKFORGE_MASTER_KEY. " +
        "Restore the master key this database was set up with (agents pin the signing key; replacing it requires re-enrolling every node).",
      { cause: err },
    );
  }
}

function fromStored(value: string | null): ControlPlaneSigner {
  const seed = value ? fromB64url(value) : null;
  if (!seed || seed.length !== 32) throw new Error("stored control-plane signing key is corrupt");
  return signerFromSeed(seed);
}
