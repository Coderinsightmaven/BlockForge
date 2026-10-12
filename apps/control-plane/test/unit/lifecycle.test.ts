import { Readable } from "node:stream";
import { buffer } from "node:stream/consumers";
import type { NodeFacts } from "@blockforge/contracts";
import { describe, expect, it } from "vitest";
import { deriveConnection, type ConnectionInputs } from "../../src/agents/connection.js";
import { ConsoleBuffers } from "../../src/agents/console-buffer.js";
import { slugify } from "../../src/agents/enrollment.js";
import { ByteLimit, TransferError } from "../../src/agents/transfers.js";
import { lockoutDurationMs, SlidingWindowLimiter } from "../../src/auth/throttle.js";
import { RingBuffer } from "../../src/lib/ring-buffer.js";
import { computeCapacity, dataRootFilesystem } from "../../src/nodes/capacity.js";
import { FIXTURE_FACTS } from "../support/fake-agent.js";

const NOW = 1_760_000_000_000;
const base: ConnectionInputs = {
  status: "active",
  sessionReady: true,
  lastHeartbeatAt: NOW - 1000,
  lastConnectedAt: NOW - 60_000,
  lastDisconnectedAt: null,
  lastDisconnectClean: false,
  clockSkewMs: 120,
  runtimeHealthy: true,
  now: NOW,
  heartbeatIntervalMs: 15_000,
  offlineAfterMs: 300_000,
};

describe("node connection state machine", () => {
  it("is online with a healthy, heartbeating session", () => {
    expect(deriveConnection(base)).toBe("online");
  });
  it("is degraded when the container runtime is unhealthy or the clock is skewed > 30 s", () => {
    expect(deriveConnection({ ...base, runtimeHealthy: false })).toBe("degraded");
    expect(deriveConnection({ ...base, clockSkewMs: -30_001 })).toBe("degraded");
    expect(deriveConnection({ ...base, clockSkewMs: 30_000 })).toBe("online");
  });
  it("is unreachable after 3 missed heartbeats", () => {
    expect(deriveConnection({ ...base, lastHeartbeatAt: NOW - 45_000 })).toBe("online");
    expect(deriveConnection({ ...base, lastHeartbeatAt: NOW - 45_001 })).toBe("unreachable");
  });
  it("is offline when never connected or revoked", () => {
    expect(deriveConnection({ ...base, sessionReady: false, lastConnectedAt: null, lastHeartbeatAt: null })).toBe("offline");
    expect(deriveConnection({ ...base, status: "revoked" })).toBe("offline");
  });
  it("is unreachable after an unclean drop, and offline only after a clean disconnect older than N minutes", () => {
    const gone = { ...base, sessionReady: false, lastDisconnectedAt: NOW - 600_000 };
    expect(deriveConnection({ ...gone, lastDisconnectClean: false })).toBe("unreachable");
    expect(deriveConnection({ ...gone, lastDisconnectClean: true })).toBe("offline");
    expect(deriveConnection({ ...gone, lastDisconnectClean: true, lastDisconnectedAt: NOW - 1000 })).toBe("unreachable");
  });
});

describe("ring buffers", () => {
  it("keeps the newest entries", () => {
    const r = new RingBuffer<number>(3);
    for (let i = 1; i <= 5; i++) r.push(i);
    expect(r.toArray()).toEqual([3, 4, 5]);
    expect(r.tail(2)).toEqual([4, 5]);
    expect(r.size).toBe(3);
  });

  it("assigns monotonic seq numbers per server console and caps the history", () => {
    const c = new ConsoleBuffers(4);
    const a = c.append("s1", [1, 2, 3].map((i) => ({ ts: i, stream: "stdout" as const, line: `l${i}` })));
    const b = c.append("s1", [4, 5].map((i) => ({ ts: i, stream: "stderr" as const, line: `l${i}` })), 7);
    c.append("s2", [{ ts: 1, stream: "stdout", line: "other" }]);
    expect(a.map((l) => l.seq)).toEqual([1, 2, 3]);
    expect(b.map((l) => l.seq)).toEqual([4, 5]);
    const tail = c.tail("s1", 10);
    expect(tail.lines.map((l) => l.seq)).toEqual([2, 3, 4, 5]);
    expect(tail.dropped).toBe(7);
    expect(c.tail("s2", 10).lines[0]?.seq).toBe(1);
    expect(c.appendSystem("s1", 9, "stopped").stream).toBe("system");
  });
});

describe("capacity", () => {
  it("derives defaults from facts: cores × 1000, memory − 1 GiB, data-root filesystem size", () => {
    const facts: NodeFacts = { ...FIXTURE_FACTS, dataRoot: "/var/lib/blockforge", filesystems: [{ mount: "/", totalBytes: 100 }, { mount: "/var/lib", totalBytes: 500 }] };
    const cap = computeCapacity(
      { cpuAllocatableMillicores: null, memoryAllocatableBytes: null, storageAllocatableBytes: null, overcommitMemoryRatio: "1.00" },
      facts,
      { cpuMillicores: 2000, memoryBytes: 1, storageBytes: 2 },
    );
    expect(cap.cpuAllocatableMillicores).toBe(64_000);
    expect(cap.memoryAllocatableBytes).toBe(137_438_953_472 - 1024 ** 3);
    expect(cap.storageAllocatableBytes).toBe(500);
    expect(cap.cpuReservedMillicores).toBe(2000);
    expect(cap.overcommitMemoryRatio).toBe(1);
  });

  it("prefers admin overrides and reports zero without facts", () => {
    const cap = computeCapacity({ cpuAllocatableMillicores: 8000, memoryAllocatableBytes: 1, storageAllocatableBytes: 2, overcommitMemoryRatio: 1.5 }, null, { cpuMillicores: 0, memoryBytes: 0, storageBytes: 0 });
    expect(cap).toMatchObject({ cpuAllocatableMillicores: 8000, memoryAllocatableBytes: 1, storageAllocatableBytes: 2, overcommitMemoryRatio: 1.5 });
    expect(computeCapacity({ cpuAllocatableMillicores: null, memoryAllocatableBytes: null, storageAllocatableBytes: null, overcommitMemoryRatio: "1" }, null, { cpuMillicores: 0, memoryBytes: 0, storageBytes: 0 }).cpuAllocatableMillicores).toBe(0);
  });

  it("matches the data root on path boundaries (Windows paths too)", () => {
    expect(dataRootFilesystem("/data2/bf", [{ mount: "/data" }, { mount: "/" }])?.mount).toBe("/");
    expect(dataRootFilesystem("C:\\BlockForge", [{ mount: "C:\\" }, { mount: "D:\\" }])?.mount).toBe("C:\\");
  });
});

describe("login throttling", () => {
  it("limits attempts per key in a sliding window", () => {
    const l = new SlidingWindowLimiter(2, 1000);
    expect(l.hit("a", 0)).toBe(0);
    expect(l.hit("a", 10)).toBe(0);
    expect(l.hit("a", 20)).toBe(980);
    expect(l.hit("b", 20)).toBe(0);
    expect(l.hit("a", 1001)).toBe(0);
  });
  it("locks out progressively: 1 min after 5 failures, doubling, max 1 h", () => {
    expect(lockoutDurationMs(4)).toBe(0);
    expect(lockoutDurationMs(5)).toBe(60_000);
    expect(lockoutDurationMs(6)).toBe(120_000);
    expect(lockoutDurationMs(20)).toBe(3_600_000);
  });
});

describe("misc helpers", () => {
  it("slugifies node names into valid slugs", () => {
    expect(slugify("MC Node #1")).toBe("mc-node-1");
    expect(slugify("x")).toBe("node-x");
    expect(slugify("Ünïcödé--Host")).toMatch(/^[a-z0-9][a-z0-9-]{1,46}[a-z0-9]$/);
  });

  it("ByteLimit passes data through and fails beyond the limit", async () => {
    expect((await buffer(Readable.from([Buffer.alloc(5), Buffer.alloc(5)]).pipe(new ByteLimit(10)))).length).toBe(10);
    await expect(buffer(Readable.from([Buffer.alloc(6), Buffer.alloc(6)]).pipe(new ByteLimit(10)))).rejects.toBeInstanceOf(TransferError);
  });
});
