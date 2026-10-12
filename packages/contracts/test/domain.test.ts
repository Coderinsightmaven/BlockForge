import { describe, expect, it } from "vitest";
import {
  ALL_PERMISSIONS,
  BUILTIN_ROLES,
  canStartOperation,
  canTransition,
  OPERATION_ALLOWED_FROM,
  RelativePath,
  SERVER_TRANSITIONS,
  ServerState,
  Topic,
} from "../src/index.js";

describe("server lifecycle", () => {
  it("every transition target is a valid state", () => {
    for (const [from, targets] of Object.entries(SERVER_TRANSITIONS)) {
      expect(ServerState.safeParse(from).success).toBe(true);
      for (const t of targets) expect(ServerState.safeParse(t).success).toBe(true);
    }
  });

  it("allows expected and rejects impossible transitions", () => {
    expect(canTransition("stopped", "starting")).toBe(true);
    expect(canTransition("starting", "running")).toBe(true);
    expect(canTransition("deleting", "running")).toBe(false);
    expect(canTransition("provision_failed", "running")).toBe(false);
  });

  it("blocks concurrent operations except kill pre-empting stop", () => {
    expect(canStartOperation("start", "stopped", null)).toBe(true);
    expect(canStartOperation("start", "running", null)).toBe(false);
    expect(canStartOperation("restart", "running", "backup")).toBe(false);
    expect(canStartOperation("kill", "stopping", "stop")).toBe(true);
    expect(canStartOperation("delete", "running", null)).toBe(false);
  });

  it("operation source states are reachable states", () => {
    for (const states of Object.values(OPERATION_ALLOWED_FROM)) {
      for (const s of states) expect(ServerState.safeParse(s).success).toBe(true);
    }
  });
});

describe("permissions", () => {
  it("built-in roles only reference known permissions", () => {
    for (const role of Object.values(BUILTIN_ROLES)) {
      for (const p of role.permissions) expect(ALL_PERMISSIONS).toContain(p);
    }
  });

  it("observer is read-only", () => {
    for (const p of BUILTIN_ROLES.observer.permissions) expect(p.endsWith(".view")).toBe(true);
  });
});

describe("RelativePath", () => {
  it.each(["server.properties", "plugins/Foo/config.yml", "", "world/region/r.0.0.mca"])("accepts %s", (p) => {
    expect(RelativePath.safeParse(p).success).toBe(true);
  });
  it.each(["/etc/passwd", "../x", "a/../../b", "C:\\Windows", "\\\\server\\share", "a\0b", "plugins\\..\\..\\x"])(
    "rejects %s",
    (p) => {
      expect(RelativePath.safeParse(p).success).toBe(false);
    },
  );
});

describe("realtime topics", () => {
  it("accepts known topics and rejects others", () => {
    expect(Topic.safeParse("overview").success).toBe(true);
    expect(Topic.safeParse("server:6f1c2b9a-4d3e-4f5a-9b8c-7d6e5f4a3b2c").success).toBe(true);
    expect(Topic.safeParse("server:*").success).toBe(false);
    expect(Topic.safeParse("admin").success).toBe(false);
  });
});
