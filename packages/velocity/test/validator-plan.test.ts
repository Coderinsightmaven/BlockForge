import { describe, expect, it } from "vitest";
import { parse as parseToml } from "smol-toml";
import { parse as parseYaml } from "yaml";
import {
  assessSecret,
  bindExposure,
  generateForwardingSecret,
  planNetworkChanges,
  sha256Hex,
  validateNetwork,
  type NetworkModelInput,
  type PlanInput,
} from "../src/index.js";
import { DEFAULT_TOML, fixture } from "./helpers.js";

const props = () => fixture("../../../minecraft/test/fixtures/properties/vanilla-26.3.server.properties");

function base(): NetworkModelInput {
  return {
    proxy: {
      name: "edge-proxy",
      serverId: "proxy-1",
      nodeId: "node-a",
      published: { nodeId: "node-a", hostIp: "0.0.0.0", hostPort: 25565 },
      publicAddress: "203.0.113.10",
      settings: { forwardingMode: "modern" },
    },
    backends: [
      { name: "lobby", serverId: "srv-lobby", nodeId: "node-a", host: "bf-lobby", port: 25565, software: "paper", minecraftVersion: "26.3", onlineMode: false, state: "running" },
      { name: "survival", serverId: "srv-survival", nodeId: "node-a", host: "bf-survival", port: 25565, software: "fabric", minecraftVersion: "26.3", onlineMode: false, state: "running" },
    ],
    try: ["lobby"],
    forcedHosts: [{ hostname: "survival.example.com", targets: ["survival"] }],
  };
}

const codes = (r: { issues: Array<{ code: string; severity: string }> }, severity?: string) =>
  r.issues.filter((i) => !severity || i.severity === severity).map((i) => i.code).sort();

describe("validateNetwork", () => {
  const strong = assessSecret(generateForwardingSecret());

  it("accepts a well-formed modern network", () => {
    const r = validateNetwork(base(), { secret: strong });
    expect(r.ok).toBe(true);
    expect(codes(r, "error")).toEqual([]);
    expect(codes(r)).toContain("FORWARDING_REQUIRES_EXTENSION"); // Fabric needs FabricProxy-Lite
  });

  it("reports missing proxy, default server and registrations", () => {
    const m = base();
    m.proxy = null;
    m.try = ["ghost", "lobby", "lobby"];
    m.forcedHosts = [{ hostname: "x.example.com", targets: ["nope"] }];
    const r = validateNetwork(m, { secret: strong });
    expect(codes(r)).toEqual(expect.arrayContaining(["NO_PROXY", "TRY_TARGET_UNKNOWN", "TRY_DUPLICATE", "FORCED_HOST_UNKNOWN_TARGET"]));
    const empty = base();
    empty.try = [];
    empty.forcedHosts = [];
    expect(codes(validateNetwork(empty, { secret: strong }), "error")).toContain("NO_DEFAULT_SERVER");
  });

  it("rejects duplicate and reserved backend names", () => {
    const m = base();
    m.backends = [...m.backends!, { ...m.backends![0]!, serverId: "srv-x" }];
    expect(codes(validateNetwork(m, { secret: strong }))).toEqual(expect.arrayContaining(["DUPLICATE_BACKEND_NAME", "DUPLICATE_BACKEND_ADDRESS"]));
    const bad = base();
    bad.backends![0]!.name = "try";
    expect(codes(validateNetwork(bad))).toEqual(["INVALID_BACKEND_NAME"]);
  });

  it("detects duplicate host ports on the same node", () => {
    const m = base();
    m.backends![0]!.published = { nodeId: "node-a", hostIp: "10.0.0.5", hostPort: 25565 };
    expect(codes(validateNetwork(m, { secret: strong }))).toContain("DUPLICATE_HOST_PORT");
    m.backends![0]!.published = { nodeId: "node-b", hostIp: "0.0.0.0", hostPort: 25565 };
    expect(codes(validateNetwork(m, { secret: strong }))).not.toContain("DUPLICATE_HOST_PORT");
  });

  it("flags publicly bound offline-mode backends and online-mode backends behind the proxy", () => {
    const m = base();
    m.backends![0]!.published = { nodeId: "node-a", hostIp: "0.0.0.0", hostPort: 25570 };
    m.backends![1]!.onlineMode = true;
    const r = validateNetwork(m, { secret: strong });
    expect(codes(r, "error")).toEqual(["BACKEND_PUBLIC_OFFLINE"]);
    expect(codes(r, "warning")).toContain("BACKEND_ONLINE_MODE"); // Fabric + hackOnlineMode → warning only
    const paper = base();
    paper.backends![0]!.onlineMode = true;
    paper.backends![0]!.published = { nodeId: "node-a", hostIp: "192.168.1.20", hostPort: 25570 };
    expect(codes(validateNetwork(paper, { secret: strong }), "error")).toEqual(["BACKEND_ONLINE_MODE"]);
  });

  it("checks forwarding support per backend", () => {
    const m = base();
    m.backends!.push({ name: "classic", host: "bf-classic", port: 25565, software: "vanilla", minecraftVersion: "26.3", onlineMode: false }, { name: "modded", host: "bf-modded", port: 25565, software: "forge", minecraftVersion: "26.3", onlineMode: false });
    const r = validateNetwork(m, { secret: strong });
    expect(r.issues.filter((i) => i.code === "FORWARDING_UNSUPPORTED").map((i) => i.subject)).toEqual(["classic"]);
    expect(r.issues.filter((i) => i.code === "FORWARDING_SUPPORT_UNKNOWN").map((i) => i.subject)).toEqual(["modded"]);
  });

  it("requires network isolation for legacy forwarding", () => {
    const m = base();
    m.proxy!.settings = { forwardingMode: "legacy" };
    m.backends = [{ name: "lobby", host: "bf-lobby", port: 25565, software: "spigot", minecraftVersion: "1.21.11", onlineMode: false, published: { nodeId: "node-a", hostIp: "198.51.100.4", hostPort: 25570 } }];
    m.forcedHosts = [];
    const r = validateNetwork(m, { secret: null });
    expect(codes(r, "error")).toEqual(expect.arrayContaining(["LEGACY_FORWARDING_WITHOUT_ISOLATION", "BACKEND_PUBLIC_OFFLINE"]));
    m.backends[0]!.published = null;
    expect(codes(validateNetwork(m, { secret: null }))).toEqual(["LEGACY_FORWARDING_INSECURE"]);
  });

  it("checks the secret and proxy settings", () => {
    expect(codes(validateNetwork(base(), { secret: null }), "error")).toEqual(["SECRET_MISSING"]);
    expect(codes(validateNetwork(base(), { secret: assessSecret("Q8hd73KsLw0p") }), "warning")).toContain("SECRET_WEAK");
    const m = base();
    m.proxy!.settings = { forwardingMode: "none", onlineMode: false, bind: "nope" };
    m.proxy!.published = null;
    const r = validateNetwork(m, { secret: null });
    expect(codes(r)).toEqual(expect.arrayContaining(["PROXY_OFFLINE_MODE", "FORWARDING_DISABLED", "PROXY_BIND_INVALID", "PROXY_NOT_PUBLISHED"]));
  });

  it("notes mixed Minecraft versions", () => {
    const m = base();
    m.backends![1]!.minecraftVersion = "1.21.11";
    expect(codes(validateNetwork(m, { secret: strong }))).toContain("MIXED_MINECRAFT_VERSIONS");
  });

  it("classifies bind exposure", () => {
    expect(["0.0.0.0", "::", "203.0.113.4", "10.1.2.3", "172.20.0.1", "192.168.0.9", "127.0.0.1", "::1", "fd12::1", "100.64.1.1"].map(bindExposure)).toEqual([
      "public",
      "public",
      "public",
      "private",
      "private",
      "private",
      "loopback",
      "loopback",
      "private",
      "private",
    ]);
  });
});

describe("planNetworkChanges", () => {
  const secret = generateForwardingSecret();
  const input = (): PlanInput => ({
    model: base(),
    secret,
    current: {
      "proxy-1": { "velocity.toml": DEFAULT_TOML(), "forwarding.secret": "Q8hd73KsLw0p" },
      "srv-lobby": { "server.properties": props(), "config/paper-global.yml": fixture("paper-global.representative.yml"), "spigot.yml": fixture("spigot.representative.yml") },
      "srv-survival": { "server.properties": props().replace("online-mode=true", "online-mode=false") },
    },
  });

  it("orders the rollout backends-first, one at a time, proxy last", async () => {
    const plan = await planNetworkChanges(input());
    expect(plan.ok).toBe(true);
    expect(plan.servers.map((s) => [s.key, s.role, s.action])).toEqual([
      ["srv-lobby", "backend", "restart"],
      ["srv-survival", "backend", "restart"],
      ["proxy-1", "proxy", "reload"],
    ]);
    expect(plan.rollout).toEqual([
      { order: 1, serverKey: "srv-lobby", action: "write-files", waitForReady: false },
      { order: 2, serverKey: "srv-lobby", action: "restart", waitForReady: true },
      { order: 3, serverKey: "srv-survival", action: "write-files", waitForReady: false },
      { order: 4, serverKey: "srv-survival", action: "restart", waitForReady: true },
      { order: 5, serverKey: "proxy-1", action: "write-files", waitForReady: false },
      { order: 6, serverKey: "proxy-1", action: "reload", waitForReady: false },
    ]);
    expect(plan.servers[2]!.reloadCommand).toBe("velocity reload");
  });

  it("produces files with before hashes, content and redacted diffs", async () => {
    const i = input();
    const plan = await planNetworkChanges(i);
    const lobby = plan.servers[0]!;
    expect(lobby.files.map((f) => f.path)).toEqual(["config/paper-global.yml", "server.properties"]);
    const pg = lobby.files[0]!;
    expect(pg.sensitive).toBe(true);
    expect(pg.beforeSha256).toBe(await sha256Hex(fixture("paper-global.representative.yml")));
    expect(pg.afterSha256).toBe(await sha256Hex(pg.afterContent));
    expect(parseYaml(pg.afterContent).proxies.velocity).toEqual({ enabled: true, "online-mode": true, secret });
    expect(pg.diff).toContain("-    enabled: false\n+    enabled: true");
    const sp = lobby.files[1]!;
    expect(sp.diff).toContain("-online-mode=true\n+online-mode=true".replace("+online-mode=true", "+online-mode=false"));

    const fabric = plan.servers[1]!;
    expect(fabric.files.map((f) => [f.path, f.beforeSha256])).toEqual([["config/FabricProxy-Lite.toml", null]]);
    expect(fabric.notes.join(" ")).toMatch(/FabricProxy-Lite/);

    const proxy = plan.servers[2]!;
    expect(proxy.files.map((f) => f.path)).toEqual(["velocity.toml", "forwarding.secret"]);
    const vt = parseToml(proxy.files[0]!.afterContent) as Record<string, Record<string, unknown>>;
    expect(vt.servers).toEqual({ lobby: "bf-lobby:25565", survival: "bf-survival:25565", try: ["lobby"] });
    expect(vt["forced-hosts"]).toEqual({ "survival.example.com": ["survival"] });
    expect(vt["player-info-forwarding-mode"]).toBe("MODERN");
    expect(proxy.files[1]!.afterContent).toBe(secret);

    const everything = JSON.stringify(plan.servers.map((s) => s.files.map((f) => f.diff)));
    expect(everything).not.toContain(secret);
    expect(everything).not.toContain("Q8hd73KsLw0p");
    expect(proxy.files[0]!.afterContent).not.toContain(secret);
  });

  it("is deterministic and idempotent", async () => {
    const a = await planNetworkChanges(input());
    const b = await planNetworkChanges(input());
    expect(a).toEqual(b);
    const applied = input();
    for (const s of a.servers) {
      const cur = { ...(applied.current[s.key] ?? {}) };
      for (const f of s.files) cur[f.path] = f.afterContent;
      (applied.current as Record<string, Record<string, string | null>>)[s.key] = cur;
    }
    const again = await planNetworkChanges(applied);
    expect(again.servers.every((s) => s.files.length === 0 && s.action === "none")).toBe(true);
    expect(again.rollout).toEqual([]);
  });

  it("blocks the proxy until Velocity generated its config, and unsupported backends", async () => {
    const i = input();
    (i.current as Record<string, Record<string, string | null>>)["proxy-1"] = {};
    const m = base();
    m.backends!.push({ name: "classic", serverId: "srv-classic", host: "bf-classic", port: 25565, software: "vanilla", minecraftVersion: "26.3", onlineMode: false });
    i.model = m;
    const plan = await planNetworkChanges(i);
    expect(plan.ok).toBe(false);
    expect(plan.servers.find((s) => s.key === "proxy-1")!.blocked[0]).toMatch(/start the proxy once/);
    expect(plan.servers.find((s) => s.key === "srv-classic")!.blocked[0]).toMatch(/Vanilla servers cannot accept Velocity forwarding/);
    expect(plan.rollout.some((r) => r.serverKey === "proxy-1" || r.serverKey === "srv-classic")).toBe(false);
    expect(plan.issues.some((x) => x.code === "FORWARDING_UNSUPPORTED")).toBe(true);
  });
});
