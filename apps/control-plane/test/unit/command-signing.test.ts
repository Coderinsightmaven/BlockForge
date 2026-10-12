import { describe, expect, it } from "vitest";
import { buildSignedCommand } from "../../src/agents/commands.js";
import { signerFromSeed } from "../../src/agents/signing-key.js";
import { FIXTURE_KEYS, loadFixture, verifyCommandFrame } from "../support/fake-agent.js";

const signer = signerFromSeed(Buffer.from(FIXTURE_KEYS.controlPlane.seedHex, "hex"));

describe("command signing", () => {
  it("derives the fixture control-plane public key from the seed", () => {
    expect(signer.publicKey).toBe(FIXTURE_KEYS.controlPlane.publicKey);
  });

  it("reproduces the golden workload.start fixture byte for byte (Ed25519 is deterministic)", () => {
    const fixture = loadFixture<{ body: string; sig: string }>("cmd-workload-start.json");
    const cmd = buildSignedCommand(
      signer.privateKey,
      FIXTURE_KEYS.nodeId,
      "workload.start",
      { workloadId: FIXTURE_KEYS.workloadId },
      FIXTURE_KEYS.now,
      300_000,
      "00000000-0000-4000-8000-000000000001",
    );
    expect(cmd.frame.body).toBe(fixture.body);
    expect(cmd.frame.sig).toBe(fixture.sig);
  });

  it("produces commands the reference agent verifier accepts", () => {
    const cmd = buildSignedCommand(signer.privateKey, FIXTURE_KEYS.nodeId, "node.probe", { host: "example.com", port: 25565, kind: "minecraft", timeoutMs: 3000 }, Date.now(), 30_000);
    expect(verifyCommandFrame(cmd.frame, FIXTURE_KEYS.controlPlane.publicKey, FIXTURE_KEYS.nodeId, Date.now()).result).toBe("ok");
  });

  it("is rejected by the reference verifier for another node, a wrong key, a modified body or after expiry", () => {
    const now = Date.now();
    const cmd = buildSignedCommand(signer.privateKey, FIXTURE_KEYS.nodeId, "node.facts", {}, now, 10_000);
    expect(verifyCommandFrame(cmd.frame, FIXTURE_KEYS.controlPlane.publicKey, "6f1c2b9a-4d3e-4f5a-9b8c-000000000000", now).result).toBe("wrong-node");
    expect(verifyCommandFrame(cmd.frame, FIXTURE_KEYS.agent.publicKey, FIXTURE_KEYS.nodeId, now).result).toBe("bad-signature");
    const tampered = { ...cmd.frame, body: cmd.frame.body.replace("node.facts", "node.probe") };
    expect(verifyCommandFrame(tampered, FIXTURE_KEYS.controlPlane.publicKey, FIXTURE_KEYS.nodeId, now).result).toBe("bad-signature");
    expect(verifyCommandFrame(cmd.frame, FIXTURE_KEYS.controlPlane.publicKey, FIXTURE_KEYS.nodeId, now + 10_000 + 30_001).result).toBe("expired");
  });

  it("caps the lifetime at 15 minutes", () => {
    const cmd = buildSignedCommand(signer.privateKey, FIXTURE_KEYS.nodeId, "node.facts", {}, 1_000, 60 * 60_000);
    expect(cmd.expiresAt - cmd.issuedAt).toBe(900_000);
    expect(verifyCommandFrame(cmd.frame, FIXTURE_KEYS.controlPlane.publicKey, FIXTURE_KEYS.nodeId, 2_000).result).toBe("ok");
  });
});
