import { Writable } from "node:stream";
import { describe, expect, it } from "vitest";
import { pino } from "pino";
import { describeMysqlError, MysqlConnector, scrub } from "../../src/databases/mysql.js";
import { ServerDatabasesService, type ServerDatabasesDeps } from "../../src/databases/service.js";
import {
  alterUserPasswordSql,
  createDatabaseSql,
  createUserSql,
  DATABASE_PRIVILEGES,
  databaseNameFor,
  dropDatabaseSql,
  dropUserSql,
  generatePassword,
  generateUsername,
  grantSql,
  PASSWORD_RE,
  remoteFor,
  UnsafeSqlValueError,
} from "../../src/databases/sql.js";
import { createLogger } from "../../src/logging/logger.js";

const DB = "s0123abcd_shop";
const USER = "u0123abcd_abcdefghij";
const PW = "Abcdefghijklmnopqrstuvwxyz012-_.~";

describe("database SQL builders", () => {
  it("builds backtick-quoted statements from validated values", () => {
    expect(createDatabaseSql(DB)).toBe("CREATE DATABASE `s0123abcd_shop` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci");
    expect(dropDatabaseSql(DB)).toBe("DROP DATABASE IF EXISTS `s0123abcd_shop`");
    expect(createUserSql(USER, "%", PW)).toBe(`CREATE USER \`${USER}\`@\`%\` IDENTIFIED BY '${PW}'`);
    expect(alterUserPasswordSql(USER, "10.0.0.0/255.0.0.0", PW)).toBe(`ALTER USER \`${USER}\`@\`10.0.0.0/255.0.0.0\` IDENTIFIED BY '${PW}'`);
    expect(dropUserSql(USER, "%")).toBe(`DROP USER IF EXISTS \`${USER}\`@\`%\``);
  });

  it("grants only database-level privileges on the server's own database, never GRANT OPTION", () => {
    // `_` is a wildcard in database-level grants: escaped unless the host reads grant names literally.
    const sql = grantSql(DB, USER, "%", true);
    expect(sql).toBe(`GRANT ${DATABASE_PRIVILEGES.join(", ")} ON \`s0123abcd\\_shop\`.* TO \`${USER}\`@\`%\``);
    expect(grantSql("s0123abcd_a_b", USER, "%", true)).toContain("ON `s0123abcd\\_a\\_b`.* TO");
    expect(grantSql(DB, USER, "%", false)).toContain(`ON \`${DB}\`.* TO`);
    expect(sql).not.toMatch(/GRANT OPTION|ALL PRIVILEGES|\*\.\*|WITH/);
    expect(DATABASE_PRIVILEGES).not.toContain("SUPER");
    expect(DATABASE_PRIVILEGES).not.toContain("FILE");
  });

  const injections = [
    "s0123abcd_shop`; DROP DATABASE mysql; --",
    "s0123abcd_shop`",
    "s0123abcd_x'",
    "s0123abcd_ shop",
    "s0123abcd_shop\0",
    "s0123abcd_SHOP",
    "s0123abcd_shop.x",
    "mysql",
    "s0123abcd_",
    `s0123abcd_${"x".repeat(49)}`,
  ];
  for (const bad of injections) {
    it(`refuses database name ${JSON.stringify(bad)}`, () => {
      expect(() => createDatabaseSql(bad)).toThrow(UnsafeSqlValueError);
      expect(() => dropDatabaseSql(bad)).toThrow(UnsafeSqlValueError);
      expect(() => grantSql(bad, USER, "%", true)).toThrow(UnsafeSqlValueError);
    });
  }

  it("refuses unsafe usernames, host patterns and passwords", () => {
    for (const u of ["root", "u0123abcd_ABCDEFGHIJ", "u0123abcd_abc`defghi", "u0123abcd_abcdefghij'", `${USER} `, "u0123abcd_abcdefghijk"]) {
      expect(() => createUserSql(u, "%", PW), u).toThrow(UnsafeSqlValueError);
      expect(() => dropUserSql(u, "%"), u).toThrow(UnsafeSqlValueError);
    }
    for (const r of ["`%`", "%' IDENTIFIED BY 'x", "% ", "a\\b", "A.B", "%_x", "x".repeat(61), ""]) {
      expect(() => createUserSql(USER, r, PW), r).toThrow(UnsafeSqlValueError);
      expect(() => grantSql(DB, USER, r, true), r).toThrow(UnsafeSqlValueError);
    }
    for (const p of ["short", "has'quote-and-is-long-enough-123", "back\\slash-and-is-long-enough-12", "space in password is long enough", "x".repeat(65)]) {
      expect(() => createUserSql(USER, "%", p), p).toThrow(UnsafeSqlValueError);
      expect(() => alterUserPasswordSql(USER, "%", p), p).toThrow(UnsafeSqlValueError);
    }
  });

  it("derives names from the server short id and refuses a bad short id or name", () => {
    expect(databaseNameFor("0123abcd", "shop")).toBe(DB);
    expect(() => databaseNameFor("0123ABCD", "shop")).toThrow(UnsafeSqlValueError);
    expect(() => databaseNameFor("0123abcd`", "shop")).toThrow(UnsafeSqlValueError);
    expect(() => databaseNameFor("0123abcd", "x`; DROP DATABASE mysql")).toThrow(UnsafeSqlValueError);
    expect(remoteFor("10.0.0.0/8")).toBe("10.0.0.0/255.0.0.0");
    expect(() => remoteFor("%' OR '1")).toThrow(UnsafeSqlValueError);
  });

  it("generates usernames within 32 characters and strong passwords", () => {
    const names = new Set<string>();
    for (let i = 0; i < 200; i++) {
      const u = generateUsername("0123abcd");
      expect(u).toMatch(/^u0123abcd_[a-z0-9]{10}$/);
      expect(u.length).toBeLessThanOrEqual(32);
      names.add(u);
      const p = generatePassword();
      expect(p).toMatch(PASSWORD_RE);
      expect(p).toHaveLength(32);
      expect(p).toMatch(/[A-Z]/);
      expect(p).toMatch(/[a-z]/);
      expect(p).toMatch(/\d/);
      expect(p).toMatch(/[-_.~]/);
    }
    expect(names.size).toBe(200);
  });
});

describe("operation claims", () => {
  const deps = (connector: MysqlConnector, operationStaleMs?: number) =>
    ({ connector, logger: pino({ level: "silent" }), ...(operationStaleMs !== undefined ? { operationStaleMs } : {}) }) as unknown as ServerDatabasesDeps;

  it("refuses a stale-claim limit that is not longer than the longest host operation (incl. the create clean-up)", () => {
    const c = new MysqlConnector({ logger: pino({ level: "silent" }) });
    // Defaults: 10 s connect, 15 s statements → the longest operation is about 4 minutes.
    expect(() => new ServerDatabasesService(deps(c, 60_000))).toThrow(/operationStaleMs/);
    expect(() => new ServerDatabasesService(deps(c, 200_000))).toThrow(/operationStaleMs/);
    const s = new ServerDatabasesService(deps(c));
    expect(s.staleMs).toBeGreaterThanOrEqual(5 * 60_000);
    expect(s.staleMs).toBeGreaterThan(c.maxSessionMs(6) + c.maxSessionMs(2));
    expect(new ServerDatabasesService(deps(c, 20 * 60_000)).staleMs).toBe(20 * 60_000);
    // The host-side statement limit stays below the client timeout; cleanup waits until a late statement cannot land.
    expect(c.sessionLimitS).toBe(12);
    // Abort procedure: connect 10 s + identity ≤ 2 × 5 s + KILL QUERY 5 s + confirmation 5 s (+ last poll 5 s) + KILL 5 s.
    expect(c.abortBudgetMs).toBe(40_000);
    // A session: connect + (setup 4 + statements) × statement timeout + abort + close.
    expect(c.maxSessionMs(2)).toBe(10_000 + 6 * 15_000 + 40_000 + 2000);
    expect(s.cleanupDelayMs).toBe(72_000);
    expect(new MysqlConnector({ logger: pino({ level: "silent" }), sessionLimits: false }).sessionLimitS).toBeNull();
  });
});

describe("database host errors", () => {
  it("never copies MySQL error text or the statement (which may contain the password)", () => {
    const err = Object.assign(new Error(`You have an error in your SQL syntax near 'IDENTIFIED BY '${PW}''`), {
      code: "ER_PARSE_ERROR",
      errno: 1064,
      sqlState: "42000",
      sqlMessage: `You have an error in your SQL syntax near '${PW}'`,
      sql: `CREATE USER x IDENTIFIED BY '${PW}'`,
    });
    const e = describeMysqlError(err, [PW], false);
    expect(e.message).toBe("MySQL error ER_PARSE_ERROR (SQLSTATE 42000)");
    expect(JSON.stringify({ ...e, message: e.message })).not.toContain(PW);
  });

  it("maps common failures to fixed descriptions", () => {
    expect(describeMysqlError(Object.assign(new Error("Access denied for user 'root'@'1.2.3.4' (using password: YES)"), { code: "ER_ACCESS_DENIED_ERROR", sqlState: "28000" }), [], true).message).toMatch(/access denied for the admin user/);
    expect(describeMysqlError(Object.assign(new Error("connect ECONNREFUSED 127.0.0.1:1"), { code: "ECONNREFUSED" }), [], true)).toMatchObject({ code: "ECONNREFUSED", message: "connection refused", connectFailed: true });
    expect(describeMysqlError(Object.assign(new Error("self-signed certificate in certificate chain"), { code: "HANDSHAKE_SSL_ERROR" }), [], true).message).toBe("TLS error: self-signed certificate in certificate chain");
    expect(describeMysqlError(new Error("boom"), [], false).message).toBe("database host error");
  });

  it("scrubs secrets from free text", () => {
    expect(scrub(`a ${PW} b ${PW}`, [PW])).not.toContain(PW);
    // Short secrets too (a 1–3 character admin password garbles the text rather than leaking).
    expect(scrub("connect as root with pw xyz failed", ["xyz"])).not.toContain("xyz");
    expect(scrub("a7 b7", ["7"])).not.toContain("7");
    expect(scrub("unchanged", [""])).toBe("unchanged");
    // A longer secret containing a shorter one is removed whole, not left as a remainder.
    expect(scrub("secret: abcdef", ["abc", "abcdef"])).toBe("secret: [REDACTED]");
    // Overlapping secrets: every match is found on the original text and the ranges merged.
    expect(scrub("xxabcdeyy", ["abcd", "cde"])).toBe("xx[REDACTED]yy");
    expect(scrub("p1-p1", ["p1"])).toBe("[REDACTED]-[REDACTED]");
    // Replacing one secret must not create or hide another (the marker itself is never matched).
    expect(scrub("RED", ["RED", "R"])).toBe("[REDACTED]");
    expect(describeMysqlError(Object.assign(new Error(`TLS failure ${PW}`), { code: "HANDSHAKE_SSL_ERROR" }), [PW], true).message).not.toContain(PW);
  });

  it("the logger never writes mysql2 statements or messages", async () => {
    const lines: string[] = [];
    const sink = new Writable({
      write(chunk, _enc, cb) {
        lines.push(String(chunk));
        cb();
      },
    });
    const logger = createLogger("debug", {}, sink);
    const err = Object.assign(new Error(`near '${PW}'`), { code: "ER_PARSE_ERROR", errno: 1064, sqlState: "42000", sqlMessage: `near '${PW}'`, sql: `ALTER USER x IDENTIFIED BY '${PW}'` });
    logger.error({ err }, "failed");
    logger.info({ password: PW, nested: { password: PW } }, "creds");
    await new Promise((r) => setImmediate(r));
    const out = lines.join("");
    expect(out).toContain("ER_PARSE_ERROR");
    expect(out).not.toContain(PW);
  });
});
