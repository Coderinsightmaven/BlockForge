import { describe, expect, it } from "vitest";
import { computeAuditHash, GENESIS_HASH, verifyChainBatch, type ChainRow } from "../../src/audit/chain.js";
import { canonicalJson } from "../../src/lib/canonical-json.js";
import { redactDeep } from "../../src/lib/redact.js";

function chain(n: number): ChainRow[] {
  const rows: ChainRow[] = [];
  let prev = GENESIS_HASH;
  for (let i = 1; i <= n; i++) {
    const fields = {
      at: 1760000000000 + i,
      actorType: "user",
      actorId: `u${i}`,
      actorName: `user${i}@example.com`,
      action: "test.action",
      targetType: "node",
      targetId: `n${i}`,
      ip: "127.0.0.1",
      requestId: `r${i}`,
      outcome: "success",
      details: { i, nested: { b: 2, a: 1 } },
    };
    const hash = computeAuditHash(prev, fields);
    rows.push({ id: i, ...fields, prevHash: prev, hash });
    prev = hash;
  }
  return rows;
}

describe("audit hash chain", () => {
  it("verifies an intact chain", () => {
    expect(verifyChainBatch(chain(5), GENESIS_HASH)).toMatchObject({ valid: true, checked: 5 });
  });

  it("is independent of object key order (canonical JSON)", () => {
    const base = chain(1)[0]!;
    const reordered = { ...base, details: { nested: { a: 1, b: 2 }, i: 1 } };
    expect(computeAuditHash(GENESIS_HASH, reordered)).toBe(base.hash);
    expect(canonicalJson({ b: 1, a: [3, { d: 1, c: 2 }] })).toBe('{"a":[3,{"c":2,"d":1}],"b":1}');
  });

  it("detects a modified field", () => {
    const rows = chain(5);
    rows[2] = { ...rows[2]!, action: "something.else" };
    expect(verifyChainBatch(rows, GENESIS_HASH)).toMatchObject({ valid: false, firstBrokenId: "3" });
  });

  it("detects modified details", () => {
    const rows = chain(4);
    rows[1] = { ...rows[1]!, details: { i: 999 } };
    expect(verifyChainBatch(rows, GENESIS_HASH)).toMatchObject({ valid: false, firstBrokenId: "2" });
  });

  it("detects a deleted row", () => {
    const rows = chain(5);
    rows.splice(2, 1);
    expect(verifyChainBatch(rows, GENESIS_HASH)).toMatchObject({ valid: false, firstBrokenId: "4" });
  });

  it("detects a re-hashed row whose successor still links to the original", () => {
    const rows = chain(3);
    const forged = { ...rows[1]!, outcome: "denied" };
    forged.hash = computeAuditHash(forged.prevHash, forged);
    rows[1] = forged;
    expect(verifyChainBatch(rows, GENESIS_HASH)).toMatchObject({ valid: false, firstBrokenId: "3" });
  });

  it("continues across batches", () => {
    const rows = chain(6);
    const first = verifyChainBatch(rows.slice(0, 3), GENESIS_HASH);
    expect(verifyChainBatch(rows.slice(3), first.lastHash).valid).toBe(true);
  });
});

describe("redaction", () => {
  it("redacts secret-looking keys and values at any depth", () => {
    const out = redactDeep({
      email: "a@example.com",
      password: "hunter2hunter2",
      nested: { webhookUrl: "https://example.com/x", list: [{ token: "abc" }], ok: 1 },
      note: "enroll with bfe_0123456789abcdef_BwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwc please",
      discord: "see https://discord.com/api/webhooks/123/abcdef",
      enabled: true,
      secret: null,
    }) as Record<string, unknown>;
    expect(out.email).toBe("a@example.com");
    expect(out.password).toBe("[REDACTED]");
    expect((out.nested as Record<string, unknown>).webhookUrl).toBe("[REDACTED]");
    expect(JSON.stringify(out)).not.toContain("hunter2");
    expect(JSON.stringify(out)).not.toContain("BwcHBwcH");
    expect(JSON.stringify(out)).not.toContain("abcdef");
    expect(out.enabled).toBe(true);
    expect(out.secret).toBeNull();
  });
});
