import { randomUUID, type KeyObject } from "node:crypto";
import { AGENT_LIMITS, type AgentCommandType, type CommandBody } from "@blockforge/contracts";
import { ed25519Sign } from "../lib/crypto.js";

export interface SignedCommand {
  id: string;
  body: CommandBody;
  frame: { t: "cmd"; body: string; sig: string };
  issuedAt: number;
  expiresAt: number;
}

/**
 * Builds a command envelope. The signature covers the exact `body` string (UTF-8), so the agent
 * verifies before parsing and no canonical-JSON scheme is required. Lifetime is capped at 15 min.
 */
export function buildSignedCommand(
  signingKey: KeyObject,
  nodeId: string,
  type: AgentCommandType,
  payload: unknown,
  now: number,
  lifetimeMs: number,
  id: string = randomUUID(),
): SignedCommand {
  const life = Math.max(1000, Math.min(lifetimeMs, AGENT_LIMITS.commandMaxLifetimeMs));
  const body: CommandBody = { id, nodeId, type, issuedAt: now, expiresAt: now + life, payload };
  const bodyString = JSON.stringify(body);
  return {
    id,
    body,
    frame: { t: "cmd", body: bodyString, sig: ed25519Sign(signingKey, Buffer.from(bodyString, "utf8")) },
    issuedAt: body.issuedAt,
    expiresAt: body.expiresAt,
  };
}
