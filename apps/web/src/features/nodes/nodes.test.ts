import { describe, expect, it } from "vitest";
import type { NodeMetricSample } from "@blockforge/contracts";
import { NODE_ID, makeNode } from "@/test/fixtures";
import { extractNode, extractNodeSample } from "@/lib/realtime/handlers";
import { summarizeNodeHealth } from "@/components/shell/node-health";
import { assignNodeColors } from "@/features/monitoring/monitoring-page";
import { tokenState } from "./enrollment-tokens";
import { matchesNodeQuery } from "./nodes-page";
import { buildNodePatch, formFromNode } from "./node-settings";
import { dataFilesystem, isStale, parseTags } from "./node-utils";

const GiB = 1024 ** 3;

function sample(fs: Array<{ mount: string; total: number; used: number }>): NodeMetricSample {
  return {
    ts: 1000,
    cpu: { usagePct: 10 },
    memory: { totalBytes: 8 * GiB, usedBytes: 2 * GiB, availableBytes: 6 * GiB },
    filesystems: fs.map((f) => ({
      mount: f.mount,
      totalBytes: f.total,
      usedBytes: f.used,
      freeBytes: f.total - f.used,
    })),
    diskIo: [],
    network: [],
  };
}

describe("parseTags", () => {
  it("normalises, de-duplicates and validates tags", () => {
    expect(parseTags(" EU, ssd ssd,fast-1 ")).toEqual({ tags: ["eu", "ssd", "fast-1"], error: null });
    expect(parseTags("").tags).toEqual([]);
    expect(parseTags("-bad, ok").error).toMatch(/-bad/);
    expect(parseTags("a".repeat(33)).error).toMatch(/Invalid tag/);
  });
});

describe("dataFilesystem", () => {
  it("picks the mount holding the data root (longest prefix)", () => {
    const node = makeNode({
      latest: sample([
        { mount: "/", total: 50 * GiB, used: 10 * GiB },
        { mount: "/srv", total: 500 * GiB, used: 100 * GiB },
        { mount: "/srv/blockforge", total: 200 * GiB, used: 20 * GiB },
      ]),
    });
    const withRoot = { ...node, facts: { dataRoot: "/srv/blockforge/data" } } as unknown as typeof node;
    expect(dataFilesystem(withRoot)?.mount).toBe("/srv/blockforge");
  });
  it("does not match sibling paths and falls back to the largest filesystem", () => {
    const node = makeNode({
      latest: sample([
        { mount: "/", total: 50 * GiB, used: 1 },
        { mount: "/data", total: 900 * GiB, used: 1 },
      ]),
    });
    const withRoot = { ...node, facts: { dataRoot: "/database" } } as unknown as typeof node;
    expect(dataFilesystem(withRoot)?.mount).toBe("/");
    expect(dataFilesystem(node)?.mount).toBe("/data");
    expect(dataFilesystem(makeNode())).toBeNull();
  });
  it("flags stale samples", () => {
    expect(isStale(1000, 1000 + 59_000)).toBe(false);
    expect(isStale(1000, 1000 + 61_000)).toBe(true);
    expect(isStale(null)).toBe(true);
  });
});

describe("buildNodePatch", () => {
  const node = makeNode({ tags: ["eu"], location: "Frankfurt" });
  it("sends nothing when nothing changed", () => {
    expect(buildNodePatch(node, formFromNode(node))).toEqual({ patch: {}, errors: {} });
  });
  it("sends only changed fields, converting units", () => {
    const form = {
      ...formFromNode(node),
      location: "",
      tags: "eu, ssd",
      cpuCores: "6.5",
      memoryGiB: "12",
      overcommit: "1.5",
      status: "maintenance" as const,
    };
    expect(buildNodePatch(node, form)).toEqual({
      patch: {
        location: null,
        tags: ["eu", "ssd"],
        cpuAllocatableMillicores: 6500,
        memoryAllocatableBytes: 12 * GiB,
        overcommitMemoryRatio: 1.5,
        status: "maintenance",
      },
      errors: {},
    });
  });
  it("reports validation errors per field", () => {
    const form = { ...formFromNode(node), name: "", cpuCores: "-1", overcommit: "9", tags: "Bad Tag!" };
    const { errors } = buildNodePatch(node, form);
    expect(Object.keys(errors).sort()).toEqual(["cpuCores", "name", "overcommit", "tags"]);
  });
});

describe("node list helpers", () => {
  it("searches name, location and tags", () => {
    const n = makeNode({ name: "Frankfurt 1", location: "DE", tags: ["ssd"] });
    expect(matchesNodeQuery(n, "frank")).toBe(true);
    expect(matchesNodeQuery(n, "SSD")).toBe(true);
    expect(matchesNodeQuery(n, "paris")).toBe(false);
  });

  it("summarises health without counting intentionally disabled nodes as down", () => {
    const s = summarizeNodeHealth([
      makeNode({ connection: "online" }),
      makeNode({ connection: "degraded" }),
      makeNode({ connection: "offline", status: "disabled" }),
      makeNode({ connection: "unreachable" }),
      makeNode({ connection: "offline", status: "revoked" }),
      makeNode({ connection: "online", status: "pending" }),
    ]);
    expect(s).toMatchObject({ total: 5, online: 2, degraded: 1, down: 1, pending: 1, tone: "danger" });
    expect(summarizeNodeHealth([]).tone).toBe("neutral");
    expect(summarizeNodeHealth([makeNode()]).tone).toBe("success");
  });

  it("classifies enrollment tokens", () => {
    const base = {
      id: NODE_ID,
      tokenId: "t",
      label: "l",
      requiresApproval: false,
      createdAt: 0,
      createdBy: null,
      usedByNodeId: null,
    };
    expect(tokenState({ ...base, expiresAt: 2000, usedAt: null }, 1000)).toBe("active");
    expect(tokenState({ ...base, expiresAt: 500, usedAt: null }, 1000)).toBe("expired");
    expect(tokenState({ ...base, expiresAt: 2000, usedAt: 900 }, 1000)).toBe("used");
  });
});

describe("monitoring colours follow the node", () => {
  const all = Array.from({ length: 10 }, (_, i) => ({ id: `n${i}` }));
  it("keeps a node's colour when the selection changes", () => {
    const a = assignNodeColors(["n1", "n3"], all);
    const b = assignNodeColors(["n3"], all);
    expect(a.get("n3")).toBe(3);
    expect(b.get("n3")).toBe(3);
  });
  it("resolves slot collisions beyond eight nodes", () => {
    const c = assignNodeColors(["n0", "n8"], all);
    expect(c.get("n0")).toBe(0);
    expect(c.get("n8")).toBe(1);
  });
});

describe("realtime payload parsing", () => {
  const s = sample([{ mount: "/", total: GiB, used: 1 }]);
  const OTHER = "33333333-3333-4333-8333-333333333333";
  it("accepts the contract's {nodeId, sample} payload for the right node only", () => {
    expect(extractNodeSample({ nodeId: NODE_ID, sample: s }, NODE_ID)?.ts).toBe(1000);
    expect(extractNodeSample({ nodeId: OTHER, sample: s }, NODE_ID)).toBeNull();
    expect(extractNodeSample(s)).toBeNull(); // bare samples are not the contract shape
    expect(extractNodeSample({ nodeId: NODE_ID, sample: { cpu: "nope" } })).toBeNull();
  });
  it("only trusts node.updated payloads that are a bare Node DTO", () => {
    const node = makeNode();
    expect(extractNode(node)?.id).toBe(NODE_ID);
    expect(extractNode({ node })).toBeNull();
    expect(extractNode({ id: NODE_ID, name: "x" })).toBeNull();
  });
});
