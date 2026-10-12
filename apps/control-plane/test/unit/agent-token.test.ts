import { sign } from "node:crypto";
import { describe, expect, it } from "vitest";
import { AgentAuthError, checkTokenTimes, parseAgentAuthorization, verifyTokenSignature } from "../../src/agents/token.js";
import { ed25519PublicKeyFromRaw } from "../../src/lib/crypto.js";
import { FIXTURE_KEYS, loadFixture, privateKeyFromSeedHex } from "../support/fake-agent.js";

const fixture = loadFixture<{ header: string; claims: { iat: number; exp: number } }>("auth-token.json");
const agentKey = ed25519PublicKeyFromRaw(FIXTURE_KEYS.agent.publicKey)!;
const cpKey = ed25519PublicKeyFromRaw(FIXTURE_KEYS.controlPlane.publicKey)!;

function token(claims: Record<string, unknown>, seedHex = FIXTURE_KEYS.agent.seedHex): string {
  const seg = Buffer.from(JSON.stringify(claims)).toString("base64url");
  return `BFAgent ${seg}.${sign(null, Buffer.from(seg, "ascii"), privateKeyFromSeedHex(seedHex)).toString("base64url")}`;
}
const base = { nid: FIXTURE_KEYS.nodeId, aud: "blockforge-control-plane" as const, iat: FIXTURE_KEYS.now, exp: FIXTURE_KEYS.now + 60_000, jti: "dGVzdC1qdGktMDAwMDAwMQ" };

describe("agent token verification", () => {
  it("accepts the golden fixture token (signature + claims + times)", () => {
    const t = parseAgentAuthorization(fixture.header);
    expect(t.claims).toEqual(fixture.claims);
    expect(verifyTokenSignature(t, agentKey)).toBe(true);
    expect(checkTokenTimes(t.claims, FIXTURE_KEYS.now + 1000)).toBeNull();
  });

  it("rejects expired tokens", () => {
    const t = parseAgentAuthorization(fixture.header);
    expect(checkTokenTimes(t.claims, fixture.claims.exp + 1)).toBe("expired");
  });

  it("rejects tokens issued in the future beyond the 30 s skew", () => {
    const t = parseAgentAuthorization(fixture.header);
    expect(checkTokenTimes(t.claims, fixture.claims.iat - 30_000)).toBeNull();
    expect(checkTokenTimes(t.claims, fixture.claims.iat - 30_001)).toBe("not_yet_valid");
  });

  it("rejects lifetimes over 120 s and non-positive lifetimes", () => {
    expect(checkTokenTimes({ ...base, exp: base.iat + 120_001 }, base.iat)).toBe("lifetime");
    expect(checkTokenTimes({ ...base, exp: base.iat }, base.iat)).toBe("lifetime");
    expect(checkTokenTimes({ ...base, exp: base.iat + 120_000 }, base.iat)).toBeNull();
  });

  it("rejects a token signed by the wrong key", () => {
    const t = parseAgentAuthorization(token(base, FIXTURE_KEYS.controlPlane.seedHex));
    expect(verifyTokenSignature(t, agentKey)).toBe(false);
    expect(verifyTokenSignature(t, cpKey)).toBe(true);
  });

  it("rejects a tampered claims segment", () => {
    const [scheme, rest] = fixture.header.split(" ");
    const [, sig] = rest!.split(".");
    const forged = Buffer.from(JSON.stringify({ ...fixture.claims, exp: fixture.claims.exp + 1 })).toString("base64url");
    const t = parseAgentAuthorization(`${scheme} ${forged}.${sig}`);
    expect(verifyTokenSignature(t, agentKey)).toBe(false);
  });

  it.each([
    ["missing", undefined],
    ["wrong scheme", fixture.header.replace("BFAgent", "Bearer")],
    ["no signature", "BFAgent abc"],
    ["two dots", "BFAgent a.b.c"],
    ["not base64url", "BFAgent a+b.c/d"],
    ["not JSON", `BFAgent ${Buffer.from("nope").toString("base64url")}.AAAA`],
    ["wrong audience", token({ ...base, aud: "someone-else" })],
    ["short jti", token({ ...base, jti: "short" })],
    ["bad node id", token({ ...base, nid: "not-a-uuid" })],
  ])("rejects malformed tokens: %s", (_name, header) => {
    expect(() => parseAgentAuthorization(header)).toThrow(AgentAuthError);
  });
});
