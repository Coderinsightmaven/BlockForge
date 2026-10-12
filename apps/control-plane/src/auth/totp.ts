import { generateSecret, generateURI, verify } from "otplib";

const ISSUER = "BlockForge";
const PERIOD_SECONDS = 30;

export function newTotpSecret(): string {
  return generateSecret({ length: 20 });
}

export function totpUri(secret: string, accountLabel: string): string {
  return generateURI({ issuer: ISSUER, label: accountLabel, secret, period: PERIOD_SECONDS, digits: 6, algorithm: "sha1" });
}

export interface TotpCheck {
  valid: boolean;
  /** RFC 6238 time step that matched; persisted to reject replays of the same code. */
  timeStep?: number;
}

/**
 * Verifies a 6-digit code allowing ±1 step of clock drift. `afterTimeStep` rejects any code whose
 * time step is not newer than the last accepted one (replay protection).
 */
export async function verifyTotp(
  secret: string,
  code: string,
  nowMs: number,
  afterTimeStep: number | null,
): Promise<TotpCheck> {
  try {
    const result = await verify({
      secret,
      token: code,
      epoch: Math.floor(nowMs / 1000),
      period: PERIOD_SECONDS,
      epochTolerance: PERIOD_SECONDS,
      ...(afterTimeStep !== null ? { afterTimeStep } : {}),
    });
    return result.valid ? { valid: true, timeStep: (result as { timeStep: number }).timeStep } : { valid: false };
  } catch {
    return { valid: false };
  }
}
