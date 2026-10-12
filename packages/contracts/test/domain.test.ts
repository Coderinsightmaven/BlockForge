import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  AGENT_COMMANDS,
  CreateServerRequest,
  expandPortList,
  isValidWorkloadSpec,
  PortList,
  SERVER_OWNER_PERMISSIONS,
  SERVER_SCOPED_PERMISSIONS,
  MutableRelativePath,
  NodeMetricSample,
  redactCommandPayload,
  WorkloadMetricSample,
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

  it("only user administrators see users and audit data", () => {
    for (const key of ["infra_admin", "network_admin", "server_admin", "moderator", "observer"] as const) {
      const perms = BUILTIN_ROLES[key].permissions as readonly string[];
      expect(perms).not.toContain("users.view");
      expect(perms).not.toContain("audit.view");
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

describe("mutation paths", () => {
  it.each(["", ".", "./", ".\\", "./."])("MutableRelativePath rejects data-root path %j", (p) => {
    expect(MutableRelativePath.safeParse(p).success).toBe(false);
  });
  it("MutableRelativePath accepts a nested file", () => {
    expect(MutableRelativePath.safeParse("plugins/a.jar").success).toBe(true);
  });
  it("fs.delete payload cannot target the root", () => {
    const wid = "1a2b3c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d";
    expect(AGENT_COMMANDS["fs.delete"].payload.safeParse({ workloadId: wid, path: ".", recursive: true }).success).toBe(false);
    expect(AGENT_COMMANDS["fs.list"].payload.safeParse({ workloadId: wid, path: "" }).success).toBe(true);
  });
});

describe("command payload redaction", () => {
  it("redacts file content, env values and signed URL queries", () => {
    expect(redactCommandPayload("fs.write", { path: "a", content: "secret" })).toEqual({ path: "a", content: "[REDACTED]" });
    expect(redactCommandPayload("workload.ensure", { env: { TOKEN: "x", TZ: "UTC" } })).toEqual({
      env: { TOKEN: "[REDACTED]", TZ: "[REDACTED]" },
    });
    expect(redactCommandPayload("artifact.fetch", { url: "https://h.example/a.jar?sig=abc" })).toEqual({
      url: "https://h.example/a.jar?[REDACTED]",
    });
    expect(redactCommandPayload("workload.start", { workloadId: "x" })).toEqual({ workloadId: "x" });
    expect(
      redactCommandPayload("workload.ensure", { command: ["java", "-Dapi.token=s3cret", "-Xmx2G", "-jar", "server.jar"] }),
    ).toEqual({ command: ["java", "-Dapi.token=[REDACTED]", "-Xmx2G", "-jar", "server.jar"] });
  });
});

describe("CreateServerRequest", () => {
  const base = {
    name: "Lobby",
    slug: "lobby",
    templateId: "6f1c2b9a-4d3e-4f5a-9b8c-7d6e5f4a3b2c",
    placement: { mode: "auto" },
    memoryLimitBytes: 4 * 1024 ** 3,
  } as const;
  const mc = { software: "paper", version: "1.21.8", acceptEula: true } as const;
  it("accepts a Minecraft server and an egg server", () => {
    expect(CreateServerRequest.safeParse({ ...base, minecraft: mc }).success).toBe(true);
    expect(CreateServerRequest.safeParse({ ...base, egg: { variables: { SAVE_NAME: "world" } } }).success).toBe(true);
  });
  it("requires exactly one of minecraft/egg", () => {
    expect(CreateServerRequest.safeParse(base).success).toBe(false);
    expect(CreateServerRequest.safeParse({ ...base, minecraft: mc, egg: {} }).success).toBe(false);
  });
  it("requires EULA for game servers but not Velocity, and heap < limit", () => {
    expect(CreateServerRequest.safeParse({ ...base, minecraft: { ...mc, acceptEula: false } }).success).toBe(false);
    expect(CreateServerRequest.safeParse({ ...base, minecraft: { software: "velocity", version: "3.4.0" } }).success).toBe(true);
    expect(CreateServerRequest.safeParse({ ...base, minecraft: { ...mc, heapMaxBytes: 4 * 1024 ** 3 } }).success).toBe(false);
  });
  it("moderators cannot send raw console commands", () => {
    expect(BUILTIN_ROLES.moderator.permissions as readonly string[]).not.toContain("servers.console.send");
  });
});

describe("server ownership permissions", () => {
  it("owners get server-scoped permissions but not delete/admin/secrets", () => {
    for (const p of SERVER_OWNER_PERMISSIONS) expect(SERVER_SCOPED_PERMISSIONS).toContain(p);
    for (const p of ["servers.delete", "servers.admin", "secrets.read", "templates.manage"]) {
      expect(SERVER_OWNER_PERMISSIONS as readonly string[]).not.toContain(p);
    }
    expect(SERVER_OWNER_PERMISSIONS).toContain("servers.files.sftp");
  });
});

describe("egg workloads and allocations", () => {
  it("image-entrypoint workloads may have an empty command; argv workloads may not", () => {
    const spec = AGENT_COMMANDS["workload.ensure"].payload.parse(
      JSON.parse(JSON.parse(readFileSync(join(import.meta.dirname, "..", "fixtures", "agent", "cmd-workload-ensure-egg.json"), "utf8")).body).payload,
    );
    expect(isValidWorkloadSpec(spec)).toBe(true);
    expect(isValidWorkloadSpec({ ...spec, entrypoint: "argv" })).toBe(false);
  });
  it("expands port lists", () => {
    expect(expandPortList("25570-25572, 25580")).toEqual([25570, 25571, 25572, 25580]);
    expect(() => expandPortList("1-2000")).toThrow();
    expect(PortList.safeParse("25565;rm").success).toBe(false);
  });
});

describe("node metric percentages", () => {
  it("rejects host CPU above 100 but allows multi-core workload CPU", () => {
    const node = { ts: 1, cpu: { usagePct: 100.5 }, memory: { totalBytes: 1, usedBytes: 1, availableBytes: 0 }, filesystems: [], diskIo: [], network: [] };
    expect(NodeMetricSample.safeParse(node).success).toBe(false);
    expect(WorkloadMetricSample.safeParse({ workloadId: "1a2b3c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d", ts: 1, running: true, cpuPct: 350 }).success).toBe(true);
  });
});

describe("realtime topics", () => {
  it("accepts known topics and rejects others", () => {
    expect(Topic.safeParse("overview").success).toBe(true);
    expect(Topic.safeParse("server:6f1c2b9a-4d3e-4f5a-9b8c-7d6e5f4a3b2c").success).toBe(true);
    expect(Topic.safeParse("server:*").success).toBe(false);
    expect(Topic.safeParse("admin").success).toBe(false);
  });
});

describe("query booleans", () => {
  it("?free=false is false", async () => {
    const { AllocationListQuery } = await import("../src/index.js");
    expect(AllocationListQuery.parse({ free: "false" }).free).toBe(false);
    expect(AllocationListQuery.parse({ free: "true" }).free).toBe(true);
    expect(AllocationListQuery.parse({}).free).toBeUndefined();
  });
});
