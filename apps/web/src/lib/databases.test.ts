import { describe, expect, it } from "vitest";
import { ApiError } from "./api/errors";
import type { ServerDatabaseStatus } from "@blockforge/contracts";
import {
  UNKNOWN_OUTCOME_MESSAGE,
  connectionString,
  databaseErrorMessage,
  deleteBlockedReason,
  hostPort,
  jdbcUrl,
  passwordBlockedReason,
  rotateBlockedReason,
  statusAllowsDelete,
  statusAllowsPassword,
  statusAllowsRotate,
  statusInProgress,
} from "./databases";

describe("database status gating", () => {
  const ALL: ServerDatabaseStatus[] = [
    "creating",
    "ready",
    "rotating",
    "deleting",
    "password_unknown",
    "cleanup_pending",
  ];
  const allowed = (fn: (s: ServerDatabaseStatus) => boolean) => ALL.filter(fn);

  it("reveals the password only while the stored one is current", () => {
    expect(allowed(statusAllowsPassword)).toEqual(["ready", "rotating", "deleting"]);
    for (const s of ALL) expect(passwordBlockedReason(s) === null).toBe(statusAllowsPassword(s));
    expect(passwordBlockedReason("password_unknown")).toMatch(/Rotate the password again/);
  });

  it("rotates ready databases and those whose password is unknown", () => {
    expect(allowed(statusAllowsRotate)).toEqual(["ready", "password_unknown"]);
    for (const s of ALL) expect(rotateBlockedReason(s) === null).toBe(statusAllowsRotate(s));
  });

  it("deletes anything but a database an operation is working on", () => {
    expect(allowed(statusAllowsDelete)).toEqual(["ready", "password_unknown", "cleanup_pending"]);
    for (const s of ALL) expect(deleteBlockedReason(s) === null).toBe(statusAllowsDelete(s));
    expect(allowed(statusInProgress)).toEqual(["creating", "rotating", "deleting"]);
  });
});

const err = (code: "CONFLICT" | "VALIDATION_FAILED" | "UPSTREAM_ERROR" | "FORBIDDEN", details?: unknown) =>
  new ApiError({ code, message: "API message", status: 409, requestId: "req-1", details });

describe("database connection strings", () => {
  const db = { host: "db.example.test", port: 3306, database: "s55555555_shop", username: "u55555555_abc" };

  it("brackets IPv6 hosts", () => {
    expect(hostPort("db.example.test", 3306)).toBe("db.example.test:3306");
    expect(hostPort("10.0.0.5", 3307)).toBe("10.0.0.5:3307");
    expect(hostPort("2001:db8::1", 3306)).toBe("[2001:db8::1]:3306");
  });

  it("builds the JDBC URL without credentials", () => {
    expect(jdbcUrl(db)).toBe("jdbc:mysql://db.example.test:3306/s55555555_shop");
    expect(jdbcUrl({ ...db, host: "::1" })).toBe("jdbc:mysql://[::1]:3306/s55555555_shop");
  });

  it("URL-encodes the credentials of the full connection string", () => {
    expect(connectionString(db, "a@b:c/d?e#f%g h")).toBe(
      "mysql://u55555555_abc:a%40b%3Ac%2Fd%3Fe%23f%25g%20h@db.example.test:3306/s55555555_shop",
    );
  });
});

describe("database error reasons", () => {
  it("maps every reason to a clear message", () => {
    expect(databaseErrorMessage(err("FORBIDDEN", { reason: "disabled" }))).toMatch(/disabled/);
    expect(databaseErrorMessage(err("CONFLICT", { reason: "limit_reached", limit: 1 }))).toMatch(
      /limit of 1 database\./,
    );
    expect(databaseErrorMessage(err("CONFLICT", { reason: "limit_reached", limit: 3 }))).toMatch(
      /limit of 3 databases\./,
    );
    expect(databaseErrorMessage(err("CONFLICT", { reason: "name_taken" }))).toMatch(/already has a database/);
    expect(databaseErrorMessage(err("CONFLICT", { reason: "host_full" }))).toMatch(/no room/);
    expect(databaseErrorMessage(err("VALIDATION_FAILED", { reason: "no_host" }))).toMatch(
      /No database host has room/,
    );
    expect(databaseErrorMessage(err("UPSTREAM_ERROR", { reason: "host_error", code: "1045" }))).toMatch(
      /\(error 1045\)/,
    );
    expect(databaseErrorMessage(err("UPSTREAM_ERROR", { reason: "host_error", code: null }))).not.toMatch(
      /\(error/,
    );
    expect(databaseErrorMessage(err("CONFLICT", { reason: "busy" }))).toBe(
      "Another operation on this database is still in progress — try again in a moment.",
    );
    expect(databaseErrorMessage(err("CONFLICT", { reason: "not_ready" }))).toBe(
      "This database is still being created or awaits cleanup.",
    );
    expect(databaseErrorMessage(err("CONFLICT", { reason: "not_ready", retryAfterMs: 44_200 }))).toBe(
      "Cleanup is scheduled; you can retry deleting in about 45 seconds (BlockForge will also remove it on its own).",
    );
    expect(databaseErrorMessage(err("CONFLICT", { reason: "not_ready", retryAfterMs: 0 }))).toMatch(
      /in about 1 second \(/,
    );
    expect(databaseErrorMessage(err("CONFLICT", { reason: "password_unknown" }))).toBe(
      "The last password rotation could not be confirmed — rotate the password again.",
    );
    const unknown = databaseErrorMessage(
      err("UPSTREAM_ERROR", { reason: "host_error", code: "ETIMEDOUT", unknownOutcome: true }),
    );
    expect(unknown).toMatch(/\(error ETIMEDOUT\)/);
    expect(unknown.endsWith(` ${UNKNOWN_OUTCOME_MESSAGE}`)).toBe(true);
    expect(UNKNOWN_OUTCOME_MESSAGE).toBe(
      "The host stopped answering mid-change; BlockForge will reconcile it (see the database's status).",
    );
    expect(
      databaseErrorMessage(
        err("UPSTREAM_ERROR", { reason: "host_error", code: "1045", unknownOutcome: false }),
      ),
    ).not.toContain(UNKNOWN_OUTCOME_MESSAGE);
    expect(databaseErrorMessage(err("CONFLICT", { reason: "has_databases", count: 2 }))).toMatch(
      /still holds 2 databases/,
    );
  });

  it("falls back to the API message for anything else", () => {
    expect(databaseErrorMessage(err("CONFLICT"))).toBe("API message");
    expect(databaseErrorMessage(err("CONFLICT", { reason: "something_new" }))).toBe("API message");
    expect(databaseErrorMessage(new Error("boom"))).toBe("boom");
  });
});
