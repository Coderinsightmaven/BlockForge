import { Writable } from "node:stream";
import { DrizzleQueryError } from "drizzle-orm/errors";
import { describe, expect, it } from "vitest";
import { pgErrorCode } from "../../src/http/errors.js";
import { createLogger, safeErrSerializer } from "../../src/logging/logger.js";

function captured() {
  const lines: string[] = [];
  const stream = new Writable({
    write(chunk, _enc, cb) {
      lines.push(String(chunk));
      cb();
    },
  });
  return { text: () => lines.join(""), logger: createLogger("info", {}, stream) };
}

describe("logging", () => {
  it("redacts credential fields", () => {
    const { text, logger } = captured();
    logger.info({ password: "hunter2", token: "abc123", headers: { authorization: "BFAgent x.y", cookie: "bf_session=1" }, ok: 1 }, "x");
    expect(text()).not.toMatch(/hunter2|BFAgent|bf_session=1|abc123/);
    expect(text()).toContain('"ok":1');
  });

  it("never logs SQL parameters of failed queries", () => {
    const pgErr = Object.assign(new Error("duplicate key value violates unique constraint"), { code: "23505", severity: "ERROR" });
    const err = new DrizzleQueryError('insert into "users" ("password_hash") values ($1)', ["$argon2id$v=19$secret-hash"], pgErr);
    const serialized = JSON.stringify(safeErrSerializer(err));
    expect(serialized).not.toContain("secret-hash");
    expect(serialized).toContain("23505");
    const { text, logger } = captured();
    logger.error({ err }, "boom");
    expect(text()).not.toContain("secret-hash");
    expect(text()).toContain("database query failed");
    expect(pgErrorCode(err)).toBe("23505");
    expect(pgErrorCode(new Error("x"))).toBeNull();
  });
});
