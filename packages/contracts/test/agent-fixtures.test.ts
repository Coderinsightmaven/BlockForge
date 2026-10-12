import { createPublicKey, verify } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  AGENT_COMMANDS,
  AGENT_LIMITS,
  AgentFrame,
  AgentTokenClaims,
  CommandBody,
  ControlPlaneFrame,
  EnrollRequest,
  EnrollResponse,
  ROTATION_PROOF_PREFIX,
} from "../src/index.js";

const dir = join(import.meta.dirname, "..", "fixtures", "agent");
const load = (name: string) => JSON.parse(readFileSync(join(dir, name), "utf8"));
const keys = load("keys.json");

function rawEd25519(publicKeyB64u: string) {
  const prefix = Buffer.from("302a300506032b6570032100", "hex");
  return createPublicKey({ key: Buffer.concat([prefix, Buffer.from(publicKeyB64u, "base64url")]), format: "der", type: "spki" });
}

/** Reference implementation of the agent-side command checks (mirrored in Go). */
function verifyCommand(frameJson: unknown, now: number) {
  const frame = ControlPlaneFrame.parse(frameJson);
  if (frame.t !== "cmd") throw new Error("not a command");
  const ok = verify(null, Buffer.from(frame.body, "utf8"), rawEd25519(keys.controlPlane.publicKey), Buffer.from(frame.sig, "base64url"));
  if (!ok) return "bad-signature";
  const body = CommandBody.parse(JSON.parse(frame.body));
  if (body.nodeId !== keys.nodeId) return "wrong-node";
  if (now > body.expiresAt + AGENT_LIMITS.commandExpiryGraceMs) return "expired";
  if (body.issuedAt > body.expiresAt) return "lifetime";
  if (body.issuedAt > now + AGENT_LIMITS.tokenClockSkewMs) return "future";
  if (body.expiresAt - body.issuedAt > AGENT_LIMITS.commandMaxLifetimeMs) return "lifetime";
  const parsed = AGENT_COMMANDS[body.type].payload.safeParse(body.payload);
  if (!parsed.success) return "invalid-payload";
  return "ok";
}

describe("agent protocol fixtures", () => {
  it("enrollment request/response match the schema", () => {
    expect(EnrollRequest.safeParse(load("enroll-request.json")).success).toBe(true);
    expect(EnrollResponse.safeParse(load("enroll-response.json")).success).toBe(true);
  });

  it("auth token signature verifies with the agent key and claims parse", () => {
    const { header, claims } = load("auth-token.json");
    const [scheme, token] = header.split(" ");
    expect(scheme).toBe("BFAgent");
    const [claimsSeg, sig] = token.split(".");
    expect(AgentTokenClaims.parse(JSON.parse(Buffer.from(claimsSeg, "base64url").toString()))).toEqual(claims);
    expect(verify(null, Buffer.from(claimsSeg, "ascii"), rawEd25519(keys.agent.publicKey), Buffer.from(sig, "base64url"))).toBe(true);
  });

  it.each([
    ["cmd-workload-start.json", "ok"],
    ["cmd-workload-ensure.json", "ok"],
    ["cmd-fs-write.json", "ok"],
    ["cmd-artifact-fetch.json", "ok"],
    ["cmd-reject-bad-signature.json", "bad-signature"],
    ["cmd-reject-wrong-node.json", "wrong-node"],
    ["cmd-reject-wrong-key.json", "bad-signature"],
    ["cmd-reject-lifetime.json", "lifetime"],
    ["cmd-reject-root-delete.json", "invalid-payload"],
    ["cmd-reject-reversed-timestamps.json", "lifetime"],
    ["cmd-credentials-rotate.json", "ok"],
    ["cmd-workload-ensure-egg.json", "ok"],
    ["cmd-workload-install.json", "ok"],
    ["cmd-backup-create.json", "ok"],
    ["cmd-backup-restore-url.json", "ok"],
    ["cmd-backup-upload.json", "ok"],
  ])("%s → %s", (file, expected) => {
    expect(verifyCommand(load(file), keys.now)).toBe(expected);
  });

  it("rejects commands past expiry + grace", () => {
    expect(verifyCommand(load("cmd-workload-start.json"), keys.now + 300_000 + 30_001)).toBe("expired");
  });

  it.each([
    "hello.json",
    "heartbeat.json",
    "progress.json",
    "result-ok.json",
    "result-error.json",
    "event-workload-state.json",
    "logs.json",
    "metrics.json",
  ])("agent frame %s parses", (file) => {
    const result = AgentFrame.safeParse(load(file));
    expect(result.success, JSON.stringify(result.error?.issues)).toBe(true);
  });

  it("rotation proof verifies with the next key over prefix + nodeId + commandId", () => {
    const frame = AgentFrame.parse(load("result-credentials-rotate.json"));
    if (frame.t !== "result" || !frame.ok) throw new Error("expected ok result");
    const data = AGENT_COMMANDS["credentials.rotate"].result.parse(frame.data);
    const message = Buffer.from(`${ROTATION_PROOF_PREFIX}${keys.nodeId}:${frame.id}`, "utf8");
    expect(verify(null, message, rawEd25519(data.publicKey), Buffer.from(data.proof, "base64url"))).toBe(true);
    expect(verify(null, message, rawEd25519(keys.agent.publicKey), Buffer.from(data.proof, "base64url"))).toBe(false);
  });

  it("welcome frame parses", () => {
    expect(ControlPlaneFrame.safeParse(load("welcome.json")).success).toBe(true);
  });
});
