import { AGENT_AUTH_SCHEME, AGENT_LIMITS, AgentTokenClaims } from "@blockforge/contracts";
import type { KeyObject } from "node:crypto";
import { ed25519Verify, fromB64url } from "../lib/crypto.js";

export type AgentAuthFailure =
  | "malformed"
  | "lifetime"
  | "not_yet_valid"
  | "expired"
  | "unknown_node"
  | "node_rejected"
  | "bad_signature"
  | "replayed";

export class AgentAuthError extends Error {
  constructor(readonly reason: AgentAuthFailure) {
    super(`agent authentication failed: ${reason}`);
    this.name = "AgentAuthError";
  }
}

export interface ParsedAgentToken {
  claims: AgentTokenClaims;
  /** The exact base64url claims segment the signature covers. */
  claimsSegment: string;
  signature: string;
}

const MAX_HEADER_LENGTH = 2048;

/** Parses `Authorization: BFAgent <b64url(claims)>.<b64url(sig)>`. Throws `AgentAuthError("malformed")`. */
export function parseAgentAuthorization(header: string | undefined): ParsedAgentToken {
  if (!header || header.length > MAX_HEADER_LENGTH) throw new AgentAuthError("malformed");
  const space = header.indexOf(" ");
  if (space < 0 || header.slice(0, space) !== AGENT_AUTH_SCHEME) throw new AgentAuthError("malformed");
  const token = header.slice(space + 1).trim();
  const dot = token.indexOf(".");
  if (dot <= 0 || dot !== token.lastIndexOf(".")) throw new AgentAuthError("malformed");
  const claimsSegment = token.slice(0, dot);
  const signature = token.slice(dot + 1);
  const raw = fromB64url(claimsSegment);
  if (!raw || !fromB64url(signature)) throw new AgentAuthError("malformed");
  let json: unknown;
  try {
    json = JSON.parse(raw.toString("utf8"));
  } catch {
    throw new AgentAuthError("malformed");
  }
  const claims = AgentTokenClaims.safeParse(json);
  if (!claims.success) throw new AgentAuthError("malformed");
  return { claims: claims.data, claimsSegment, signature };
}

/** Lifetime ≤ 120 s; `now` within `[iat - 30 s, exp]`. */
export function checkTokenTimes(claims: AgentTokenClaims, now: number): AgentAuthFailure | null {
  if (claims.exp <= claims.iat || claims.exp - claims.iat > AGENT_LIMITS.tokenMaxLifetimeMs) return "lifetime";
  if (now < claims.iat - AGENT_LIMITS.tokenClockSkewMs) return "not_yet_valid";
  if (now > claims.exp) return "expired";
  return null;
}

/** Signature over the ASCII bytes of the claims segment. */
export function verifyTokenSignature(token: ParsedAgentToken, publicKey: KeyObject): boolean {
  return ed25519Verify(publicKey, Buffer.from(token.claimsSegment, "ascii"), token.signature);
}
