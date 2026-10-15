import { describe, expect, it } from "vitest";
import {
  BUILTIN_ROLES,
  CreateDatabaseHostRequest,
  CreateServerDatabaseRequest,
  DatabaseHost,
  DatabaseHostAddress,
  normalizeDatabaseRemote,
  PemCertificate,
  SERVER_OWNER_PERMISSIONS,
  ServerDatabase,
  ServerDatabaseName,
  serverDatabaseFullName,
  SUBUSER_ASSIGNABLE_PERMISSIONS,
  TestDatabaseHostRequest,
} from "../src/index.js";

describe("database names", () => {
  it("accepts 1–48 lowercase letters, digits and underscores only", () => {
    for (const ok of ["a", "shop", "luckperms_2", "_", "x".repeat(48)]) expect(ServerDatabaseName.safeParse(ok).success, ok).toBe(true);
    for (const bad of ["", "Shop", "a-b", "a b", "x".repeat(49), "a`b", "a'b", "a;drop", "é", "a\0", "a.b", "a/b", "%"]) {
      expect(ServerDatabaseName.safeParse(bad).success, JSON.stringify(bad)).toBe(false);
    }
  });

  it("builds s<shortId>_<name> within MySQL's 64-character limit", () => {
    const full = serverDatabaseFullName("0123abcd", "x".repeat(48));
    expect(full).toBe(`s0123abcd_${"x".repeat(48)}`);
    expect(full.length).toBeLessThanOrEqual(64);
  });
});

describe("normalizeDatabaseRemote", () => {
  const cases: [string, string | null][] = [
    ["%", "%"],
    ["  %  ", "%"],
    ["10.0.0.5", "10.0.0.5"],
    ["10.%", "10.%"],
    ["192.168.1.%", "192.168.1.%"],
    ["10.0.0.0/8", "10.0.0.0/255.0.0.0"],
    ["192.168.10.0/24", "192.168.10.0/255.255.255.0"],
    ["172.16.0.0/12", "172.16.0.0/255.240.0.0"],
    ["10.1.2.3/32", "10.1.2.3/255.255.255.255"],
    ["10.1.0.0/255.255.0.0", "10.1.0.0/255.255.0.0"],
    ["localhost", "localhost"],
    ["App-01.Example.COM", "app-01.example.com"],
    ["%.example.com", "%.example.com"],
    ["::1", "::1"],
    ["FE80::1", "fe80::1"],
    ["2001:db8:0:0:0:0:0:1", "2001:db8:0:0:0:0:0:1"],
    // Refused
    ["", null],
    ["%%", null],
    ["10.0.0.1/24", null], // host bits set
    ["10.0.0.0/33", null],
    ["10.0.0.0/0", null],
    ["10.0.0.0/255.0.255.0", null], // non-contiguous mask
    ["256.1.1.1", null],
    ["1.2.3", null],
    ["10.%.1", null],
    ["300.%", null],
    ["a b", null],
    ["host'", null],
    ["host`", null],
    ["%' IDENTIFIED BY 'x", null],
    ["`%`@`%`", null],
    ["a\\b", null],
    ["host;drop", null],
    ["-bad.example.com", null],
    ["_", null],
    ["a%b", null],
    ["1:2::3::4", null],
    ["x".repeat(61), null],
  ];
  for (const [input, expected] of cases) {
    it(`${JSON.stringify(input)} → ${JSON.stringify(expected)}`, () => {
      expect(normalizeDatabaseRemote(input)).toBe(expected);
      if (expected !== null) expect(expected).toMatch(/^[a-z0-9.%:/-]{1,60}$/);
    });
  }

  it("CreateServerDatabaseRequest normalises remote and defaults to %", () => {
    expect(CreateServerDatabaseRequest.parse({ name: "shop" })).toEqual({ name: "shop", remote: "%" });
    expect(CreateServerDatabaseRequest.parse({ name: "shop", remote: "10.2.0.0/16" }).remote).toBe("10.2.0.0/255.255.0.0");
    expect(CreateServerDatabaseRequest.safeParse({ name: "shop", remote: "10.2.0.1/16" }).success).toBe(false);
    expect(CreateServerDatabaseRequest.safeParse({ name: "shop", extra: 1 }).success).toBe(false);
  });
});

describe("database host contracts", () => {
  const base = { name: "Main", host: "db.internal", username: "root", password: "pw" };

  it("validates addresses and never accepts a scheme, port or path", () => {
    for (const ok of ["db.internal", "127.0.0.1", "mysql", "::1", "fd00::5"]) expect(DatabaseHostAddress.safeParse(ok).success, ok).toBe(true);
    for (const bad of ["mysql://db", "db:3306", "db/x", "", "a b", "-db"]) expect(DatabaseHostAddress.safeParse(bad).success, bad).toBe(false);
  });

  it("applies defaults and requires the password on create", () => {
    expect(CreateDatabaseHostRequest.parse(base)).toMatchObject({ port: 3306, tlsMode: "preferred", maxDatabases: null, nodeId: null, publicHost: null, tlsCaCertificate: null, notes: "" });
    expect(CreateDatabaseHostRequest.safeParse({ ...base, password: "" }).success).toBe(false);
    expect(CreateDatabaseHostRequest.safeParse({ ...base, username: "a\nb" }).success).toBe(false);
    expect(CreateDatabaseHostRequest.safeParse({ ...base, tlsCaCertificate: "not a cert" }).success).toBe(false);
  });

  it("accepts a CA certificate only with verify_ca, which requires one", () => {
    const ca = "-----BEGIN CERTIFICATE-----\nAAAA\n-----END CERTIFICATE-----";
    expect(CreateDatabaseHostRequest.safeParse({ ...base, tlsMode: "verify_ca", tlsCaCertificate: ca }).success).toBe(true);
    expect(CreateDatabaseHostRequest.safeParse({ ...base, tlsMode: "verify_ca" }).success).toBe(false);
    for (const tlsMode of ["disabled", "preferred", "required"]) {
      expect(CreateDatabaseHostRequest.safeParse({ ...base, tlsMode }).success, tlsMode).toBe(true);
      expect(CreateDatabaseHostRequest.safeParse({ ...base, tlsMode, tlsCaCertificate: ca }).success, tlsMode).toBe(false);
    }
    expect(TestDatabaseHostRequest.safeParse({ host: "db", username: "root", password: "x", tlsMode: "verify_ca" }).success).toBe(false);
    expect(TestDatabaseHostRequest.safeParse({ host: "db", username: "root", password: "x", tlsMode: "required", tlsCaCertificate: ca }).success).toBe(false);
  });

  it("test request needs a password or a saved host", () => {
    expect(TestDatabaseHostRequest.safeParse({ host: "db", username: "root" }).success).toBe(false);
    expect(TestDatabaseHostRequest.safeParse({ host: "db", username: "root", hostId: "6f1c3c1e-6c1d-4a63-9c1b-0d1f0a7b5e11" }).success).toBe(true);
    expect(PemCertificate.safeParse("-----BEGIN CERTIFICATE-----\nAAAA\n-----END CERTIFICATE-----").success).toBe(true);
  });

  it("host and database DTOs are strict: a password field is rejected", () => {
    const host = {
      id: "6f1c3c1e-6c1d-4a63-9c1b-0d1f0a7b5e11",
      name: "Main",
      host: "db",
      port: 3306,
      publicHost: null,
      username: "root",
      nodeId: null,
      nodeName: null,
      maxDatabases: null,
      databaseCount: 0,
      tlsMode: "preferred",
      tlsCaCertificate: null,
      notes: "",
      createdAt: 1,
      updatedAt: 1,
    };
    expect(DatabaseHost.safeParse(host).success).toBe(true);
    expect(DatabaseHost.safeParse({ ...host, password: "x" }).success).toBe(false);
    const db = {
      id: host.id,
      serverId: host.id,
      hostId: host.id,
      hostName: "Main",
      host: "db",
      port: 3306,
      database: "s0123abcd_shop",
      username: "u0123abcd_abcdefghij",
      remote: "%",
      createdAt: 1,
      passwordRotatedAt: null,
    };
    expect(ServerDatabase.safeParse(db).success).toBe(true);
    expect(ServerDatabase.safeParse({ ...db, password: "x" }).success).toBe(false);
  });
});

describe("database permissions", () => {
  it("owners and subusers can hold every server database permission; view_password is not a .view permission", () => {
    for (const p of ["servers.databases.view", "servers.databases.create", "servers.databases.update", "servers.databases.delete", "servers.databases.view_password"] as const) {
      expect(SERVER_OWNER_PERMISSIONS).toContain(p);
      expect(SUBUSER_ASSIGNABLE_PERMISSIONS).toContain(p);
    }
    expect(BUILTIN_ROLES.observer.permissions).toContain("servers.databases.view");
    expect(BUILTIN_ROLES.observer.permissions).not.toContain("servers.databases.view_password");
    expect(BUILTIN_ROLES.moderator.permissions).not.toContain("servers.databases.view");
    expect(BUILTIN_ROLES.infra_admin.permissions).toContain("database_hosts.manage");
    expect(BUILTIN_ROLES.infra_admin.permissions).not.toContain("servers.databases.view_password");
    expect(SERVER_OWNER_PERMISSIONS).not.toContain("database_hosts.manage");
  });
});
