import { hash, verify } from "@node-rs/argon2";

/**
 * argon2id (the @node-rs/argon2 default algorithm) with OWASP-recommended parameters
 * (19 MiB, t=2, p=1). Parameters are encoded in the PHC string, so they can be raised later
 * without invalidating existing hashes.
 */
const OPTIONS = { memoryCost: 19_456, timeCost: 2, parallelism: 1, outputLen: 32 } as const;

export function hashPassword(password: string): Promise<string> {
  return hash(password, OPTIONS);
}

export async function verifyPassword(passwordHash: string, password: string): Promise<boolean> {
  try {
    return await verify(passwordHash, password);
  } catch {
    return false;
  }
}

let dummyHash: Promise<string> | null = null;

/** Verifies against a throwaway hash so unknown accounts cost the same time as known ones. */
export async function burnPasswordCheck(password: string): Promise<void> {
  dummyHash ??= hashPassword("blockforge-timing-equaliser-not-a-password");
  await verifyPassword(await dummyHash, password);
}
