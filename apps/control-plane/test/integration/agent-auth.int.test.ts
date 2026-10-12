import { randomUUID, sign } from "node:crypto";
import { pino } from "pino";
import { beforeEach, describe, expect, it } from "vitest";
import { AgentAuthenticator, RotationCoordinator } from "../../src/agents/authenticator.js";
import { AgentAuthError } from "../../src/agents/token.js";
import { createDb } from "../../src/db/client.js";
import type { Clock } from "../../src/lib/clock.js";
import { testPool, truncateAll } from "../support/db.js";
import { FIXTURE_KEYS, loadFixture, privateKeyFromSeedHex, rawPublicKey } from "../support/fake-agent.js";

const fixture = loadFixture<{ header: string; claims: { iat: number; exp: number } }>("auth-token.json");
const NODE = FIXTURE_KEYS.nodeId;

class FixedClock implements Clock {
  constructor(public t: number) {}
  now() {
    return this.t;
  }
}

function header(claims: Partial<{ nid: string; iat: number; exp: number; jti: string }>, seedHex = FIXTURE_KEYS.agent.seedHex): string {
  const full = { nid: NODE, aud: "blockforge-control-plane", iat: FIXTURE_KEYS.now, exp: FIXTURE_KEYS.now + 60_000, jti: randomUUID().replace(/-/g, ""), ...claims };
  const seg = Buffer.from(JSON.stringify(full)).toString("base64url");
  return `BFAgent ${seg}.${sign(null, Buffer.from(seg, "ascii"), privateKeyFromSeedHex(seedHex)).toString("base64url")}`;
}

async function reason(p: Promise<unknown>): Promise<string> {
  try {
    await p;
    return "ok";
  } catch (err) {
    if (err instanceof AgentAuthError) return err.reason;
    throw err;
  }
}

describe("agent authenticator (fixture keys, durable jti)", () => {
  const pool = testPool();
  const db = createDb(pool);
  const clock = new FixedClock(FIXTURE_KEYS.now + 1000);
  const auth = new AgentAuthenticator(db, clock, new RotationCoordinator(), pino({ level: "silent" }));

  beforeEach(async () => {
    await truncateAll(pool);
    clock.t = FIXTURE_KEYS.now + 1000;
    await pool.query("INSERT INTO nodes (id, name, slug, status) VALUES ($1, 'fixture-node', 'fixture-node', 'active')", [NODE]);
    await pool.query("INSERT INTO node_credentials (id, node_id, public_key, status) VALUES ($1, $2, $3, 'active')", [randomUUID(), NODE, FIXTURE_KEYS.agent.publicKey]);
  });

  it("accepts the golden fixture token once and rejects its replay (persisted jti)", async () => {
    expect(await auth.authenticate(fixture.header)).toMatchObject({ nodeId: NODE, status: "active", promoted: false });
    const { rows } = await pool.query("SELECT jti, expires_at FROM agent_auth_jti");
    expect(rows).toEqual([{ jti: "dGVzdC1qdGktMDAwMDAwMQ", expires_at: new Date(fixture.claims.exp) }]);
    expect(await reason(auth.authenticate(fixture.header))).toBe("replayed");
    // A second authenticator (another replica / after restart) shares the replay state.
    const other = new AgentAuthenticator(db, clock, new RotationCoordinator(), pino({ level: "silent" }));
    expect(await reason(other.authenticate(fixture.header))).toBe("replayed");
  });

  it("rejects expired, future, wrong-key, unknown-node and revoked/disabled-node tokens", async () => {
    clock.t = fixture.claims.exp + 1;
    expect(await reason(auth.authenticate(fixture.header))).toBe("expired");
    clock.t = FIXTURE_KEYS.now - 30_001;
    expect(await reason(auth.authenticate(fixture.header))).toBe("not_yet_valid");
    clock.t = FIXTURE_KEYS.now + 1000;
    expect(await reason(auth.authenticate(header({}, FIXTURE_KEYS.controlPlane.seedHex)))).toBe("bad_signature");
    expect(await reason(auth.authenticate(header({ nid: randomUUID() })))).toBe("unknown_node");
    await pool.query("UPDATE nodes SET status = 'disabled'");
    expect(await reason(auth.authenticate(header({})))).toBe("node_rejected");
    await pool.query("UPDATE nodes SET status = 'revoked'");
    expect(await reason(auth.authenticate(header({})))).toBe("node_rejected");
    // Rejections never consume a jti.
    expect((await pool.query("SELECT count(*)::int AS n FROM agent_auth_jti")).rows[0].n).toBe(0);
  });

  it("accepts a pending rotated key until it expires and promotes it on first use", async () => {
    const nextSeed = "03".repeat(32);
    const nextPublic = rawPublicKey(privateKeyFromSeedHex(nextSeed));
    await pool.query("INSERT INTO node_credentials (id, node_id, public_key, status, expires_at) VALUES ($1, $2, $3, 'pending', $4)", [
      randomUUID(),
      NODE,
      nextPublic,
      new Date(clock.t + 900_000),
    ]);
    // Old key still works while the rotation is pending.
    expect((await auth.authenticate(header({}))).promoted).toBe(false);
    expect((await auth.authenticate(header({}, nextSeed))).promoted).toBe(true);
    const { rows } = await pool.query("SELECT public_key, status FROM node_credentials ORDER BY status");
    expect(rows).toEqual([
      { public_key: nextPublic, status: "active" },
      { public_key: FIXTURE_KEYS.agent.publicKey, status: "rotated" },
    ]);
    expect(await reason(auth.authenticate(header({})))).toBe("bad_signature");
  });

  it("ignores expired pending keys and prunes expired state", async () => {
    const nextSeed = "04".repeat(32);
    await pool.query("INSERT INTO node_credentials (id, node_id, public_key, status, expires_at) VALUES ($1, $2, $3, 'pending', $4)", [
      randomUUID(),
      NODE,
      rawPublicKey(privateKeyFromSeedHex(nextSeed)),
      new Date(clock.t - 1),
    ]);
    expect(await reason(auth.authenticate(header({}, nextSeed)))).toBe("bad_signature");
    await auth.authenticate(header({}));
    clock.t = FIXTURE_KEYS.now + 120_000;
    await auth.prune();
    expect((await pool.query("SELECT count(*)::int AS n FROM agent_auth_jti")).rows[0].n).toBe(0);
    expect((await pool.query("SELECT status FROM node_credentials WHERE status <> 'active'")).rows).toEqual([{ status: "revoked" }]);
  });
});
