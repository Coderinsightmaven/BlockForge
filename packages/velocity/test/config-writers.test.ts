import { describe, expect, it } from "vitest";
import { parse as parseToml } from "smol-toml";
import { parse as parseYaml } from "yaml";
import { getProperty, parseProperties } from "@blockforge/minecraft";
import {
  BACKEND_FILES,
  ForwardingConfigError,
  NetworkModel,
  REDACTED,
  TomlDocument,
  backendForwardingFiles,
  editYaml,
  formatHostPort,
  generateForwardingSecret,
  maskYamlPaths,
  redactFileForDisplay,
  redactGenericLines,
  renderVelocityToml,
  writeBungeeGuardConfig,
  writeFabricProxyLiteConfig,
  writePaperVelocityConfig,
  writePcfConfig,
  writeSpigotBungeecord,
  type NetworkModelInput,
} from "../src/index.js";
import { DEFAULT_TOML, changedLines, commentLines, fixture } from "./helpers.js";

const model = (over: Partial<NetworkModelInput> = {}): NetworkModel =>
  NetworkModel.parse({
    proxy: { name: "proxy", settings: { forwardingMode: "modern", motd: "<aqua>BlockForge network", showMaxPlayers: 200 } },
    backends: [
      { name: "lobby", host: "bf-lobby", port: 25565, software: "paper", minecraftVersion: "26.3" },
      { name: "survival", host: "10.0.0.12", port: 25566, software: "fabric", minecraftVersion: "1.21.11" },
      { name: "v6", host: "fd00::12", port: 25565, software: "paper", minecraftVersion: "26.3" },
    ],
    try: ["lobby", "survival"],
    forcedHosts: [
      { hostname: "play.example.com", targets: ["lobby"] },
      { hostname: "survival.example.com", targets: ["survival", "lobby"] },
    ],
    ...over,
  });

describe("velocity.toml rendering (real 4.2.0 default)", () => {
  it("applies the model with targeted edits and keeps every comment", () => {
    const before = DEFAULT_TOML();
    const r = renderVelocityToml(before, model());
    const data = parseToml(r.content) as Record<string, Record<string, unknown>>;
    expect(r.configVersion).toBe(2.9);
    expect(data).toMatchObject({
      "config-version": "2.9",
      motd: "<aqua>BlockForge network",
      "show-max-players": 200,
      "player-info-forwarding-mode": "MODERN",
      "forwarding-secret-file": "forwarding.secret",
      servers: { lobby: "bf-lobby:25565", survival: "10.0.0.12:25566", v6: "[fd00::12]:25565", try: ["lobby", "survival"] },
      "forced-hosts": { "play.example.com": ["lobby"], "survival.example.com": ["survival", "lobby"] },
      advanced: { "compression-threshold": 256, "read-timeout": 30000 },
    });
    expect(commentLines(r.content)).toEqual(commentLines(before));
    expect(r.content).toContain("[packet-limiter]\n# Size of the moving time window");
    // idempotent: rendering the result again changes nothing
    expect(renderVelocityToml(r.content, model()).content).toBe(r.content);
  });

  it("migrates nothing it does not own and never writes a secret", () => {
    const legacy = [
      'config-version = "1.0"',
      'bind = "0.0.0.0:25577"',
      "# old inline secret",
      'forwarding-secret = "s3cr3t-inline-value"',
      'ping-passthrough = "DISABLED"',
      "[servers]",
      'lobby = "127.0.0.1:30066"',
      'try = ["lobby"]',
      "[forced-hosts]",
      "[advanced]",
      "compression-threshold = 256 # keep this comment",
      "[query]",
      "enabled = false",
      "port = 25577",
      "",
    ].join("\n");
    const m = model();
    m.proxy!.settings.pingPassthrough = { version: false, players: false, description: true, favicon: false, modinfo: true };
    const r = renderVelocityToml(legacy, m);
    expect(r.content).not.toContain("s3cr3t-inline-value");
    expect(r.notes.join(" ")).toMatch(/deprecated inline `forwarding-secret`/);
    expect(r.content).toContain('ping-passthrough = "DESCRIPTION"');
    expect(r.content).toContain("compression-threshold = 256 # keep this comment");
    expect(r.content).not.toContain("[ping-passthrough]");
  });

  it("formats IPv6 backend addresses", () => {
    expect(formatHostPort("fd00::1", 25565)).toBe("[fd00::1]:25565");
    expect(formatHostPort("bf-lobby", 25565)).toBe("bf-lobby:25565");
  });
});

describe("backend config writers", () => {
  const secret = generateForwardingSecret();

  it("edits paper-global.yml in place, keeping comments and every other line", () => {
    const before = fixture("paper-global.representative.yml");
    const r = writePaperVelocityConfig(before, "26.3", { enabled: true, onlineMode: true, secret });
    expect(r.path).toBe("config/paper-global.yml");
    expect(changedLines(before, r.content)).toEqual([
      ["    enabled: false", "    enabled: true"],
      ["    secret: ''", `    secret: '${secret}'`],
    ]);
    expect(parseYaml(r.content).proxies.velocity).toEqual({ enabled: true, "online-mode": true, secret });
    const again = writePaperVelocityConfig(r.content, "26.3", { enabled: true, onlineMode: true, secret });
    expect(again.changed).toBe(false);
    expect(again.content).toBe(r.content);
  });

  it("creates missing keys/files and targets paper.yml before 1.19", () => {
    const created = writePaperVelocityConfig(null, "1.21.11", { enabled: true, onlineMode: false, secret: "x-y" });
    expect(created.created).toBe(true);
    expect(parseYaml(created.content)).toEqual({ proxies: { velocity: { enabled: true, "online-mode": false, secret: "x-y" } } });
    const legacy = writePaperVelocityConfig("# paper.yml\nsettings:\n  timings: true\n", "1.18.2", { enabled: true, onlineMode: true, secret: "abc" });
    expect(legacy.path).toBe("paper.yml");
    expect(legacy.content).toContain("# paper.yml");
    expect(parseYaml(legacy.content).settings).toEqual({ timings: true, "velocity-support": { enabled: true, "online-mode": true, secret: "abc" } });
  });

  it("toggles spigot.yml bungeecord with a one-line change", () => {
    const before = fixture("spigot.representative.yml");
    const r = writeSpigotBungeecord(before, true);
    expect(changedLines(before, r.content)).toEqual([["  bungeecord: false", "  bungeecord: true"]]);
  });

  it("writes BungeeGuard tokens, FabricProxy-Lite and PCF configs", () => {
    const bg = writeBungeeGuardConfig("# BungeeGuard\nallowed-tokens:\n- old-token\n", "new-token-value");
    expect(parseYaml(bg.content)["allowed-tokens"]).toEqual(["new-token-value"]);
    expect(bg.content).toContain("# BungeeGuard");
    const fpl = writeFabricProxyLiteConfig('hackOnlineMode = true\nhackEarlySend = false\n# set me\nsecret = ""\n', { secret });
    expect(changedLines('hackOnlineMode = true\nhackEarlySend = false\n# set me\nsecret = ""\n', fpl.content)).toEqual([['secret = ""', `secret = "${secret}"`]]);
    const fresh = writeFabricProxyLiteConfig(null, { secret, hackEarlySend: true });
    expect(parseToml(fresh.content)).toEqual({ hackEarlySend: true, secret });
    const pcf = writePcfConfig(null, { mode: "MODERN", secret });
    expect(parseToml(pcf.content)).toEqual({ forwarding: { enabled: true, mode: "MODERN", secret } });
  });

  it("computes complete backend file sets per software", () => {
    const props = fixture("../../../minecraft/test/fixtures/properties/vanilla-26.3.server.properties");
    const paper = backendForwardingFiles({
      software: "paper",
      minecraftVersion: "26.3",
      mode: "modern",
      secret,
      proxyOnlineMode: true,
      files: { "server.properties": props, "config/paper-global.yml": fixture("paper-global.representative.yml"), "spigot.yml": fixture("spigot.representative.yml") },
    });
    expect(Object.keys(paper.files).sort()).toEqual(["config/paper-global.yml", "server.properties"]);
    expect(getProperty(parseProperties(paper.files["server.properties"]!), "online-mode")).toBe("false");
    expect(paper.restartRequired).toBe(true);

    const legacy = backendForwardingFiles({ software: "paper", minecraftVersion: "26.3", mode: "legacy", secret: null, proxyOnlineMode: true, files: { "spigot.yml": fixture("spigot.representative.yml") } });
    expect(Object.keys(legacy.files).sort()).toEqual(["server.properties", "spigot.yml"]);
    expect(legacy.created).toEqual(["server.properties"]);

    const fabric = backendForwardingFiles({ software: "fabric", minecraftVersion: "1.21.11", mode: "modern", secret, proxyOnlineMode: true, files: {} });
    expect(Object.keys(fabric.files).sort()).toEqual([BACKEND_FILES.fabricProxyLite, "server.properties"]);
    expect(fabric.requires).toEqual(["FabricProxy-Lite", "Fabric API"]);

    const neo = backendForwardingFiles({ software: "neoforge", minecraftVersion: "1.21.1", mode: "modern", secret, proxyOnlineMode: true, files: {} });
    expect(Object.keys(neo.files).sort()).toEqual([BACKEND_FILES.pcf, "server.properties"]);

    const vanilla = backendForwardingFiles({ software: "vanilla", minecraftVersion: "26.3", mode: "none", secret: null, proxyOnlineMode: true, files: {} });
    expect(Object.keys(vanilla.files)).toEqual(["server.properties"]);

    expect(() => backendForwardingFiles({ software: "vanilla", minecraftVersion: "26.3", mode: "modern", secret, proxyOnlineMode: true, files: {} })).toThrow(ForwardingConfigError);
    expect(() => backendForwardingFiles({ software: "paper", minecraftVersion: "26.3", mode: "modern", secret: null, proxyOnlineMode: true, files: {} })).toThrow(/needs a forwarding secret/);
  });

  it("disables a previously enabled Paper modern forwarding when switching modes", () => {
    const enabled = writePaperVelocityConfig(fixture("paper-global.representative.yml"), "26.3", { enabled: true, onlineMode: true, secret }).content;
    const r = backendForwardingFiles({ software: "paper", minecraftVersion: "26.3", mode: "legacy", secret: null, proxyOnlineMode: true, files: { "config/paper-global.yml": enabled } });
    expect(parseYaml(r.files["config/paper-global.yml"]!).proxies.velocity.enabled).toBe(false);
  });
});

describe("redaction never leaks the secret", () => {
  const secret = generateForwardingSecret();

  it("masks every secret-bearing file BlockForge writes", () => {
    const files: Record<string, string> = {
      "forwarding.secret": secret,
      "config/paper-global.yml": writePaperVelocityConfig(fixture("paper-global.representative.yml"), "26.3", { enabled: true, onlineMode: true, secret }).content,
      "paper.yml": writePaperVelocityConfig(null, "1.18.2", { enabled: true, onlineMode: true, secret }).content,
      "plugins/BungeeGuard/config.yml": writeBungeeGuardConfig(null, secret).content,
      "config/FabricProxy-Lite.toml": writeFabricProxyLiteConfig(null, { secret }).content,
      "config/proxy-compatible-forge.toml": writePcfConfig(null, { mode: "MODERN", secret }).content,
      "velocity.toml": `forwarding-secret = "${secret}"\nforwarding-secret-file = "forwarding.secret"\n`,
      "server.properties": `rcon.password=${secret}\nmanagement-server-secret=${secret}\nmotd=hi\n`,
    };
    for (const [path, content] of Object.entries(files)) {
      expect(content, path).toContain(secret);
      const structural = redactFileForDisplay(path, content);
      expect(structural.content, `${path} (structural)`).not.toContain(secret);
      expect(structural.redacted).toBe(true);
      expect(redactFileForDisplay(path, content, { knownSecrets: [secret] }).content).not.toContain(secret);
    }
    const yamlOut = redactFileForDisplay("config/paper-global.yml", files["config/paper-global.yml"]!).content;
    expect(yamlOut).toContain(`secret: '${REDACTED}'`);
    expect(yamlOut).toContain("# This is the global configuration file for Paper.");
    expect(redactFileForDisplay("velocity.toml", files["velocity.toml"]!).content).toContain('forwarding-secret-file = "forwarding.secret"');
  });

  it("falls back to generic and known-value redaction for unknown or broken files", () => {
    const broken = `proxies:\n  velocity:\n    secret: '${secret}\n  : : bad yaml [\n`;
    expect(redactFileForDisplay("config/paper-global.yml", broken, { knownSecrets: [secret] }).content).not.toContain(secret);
    const unknown = `some-plugin:\n  api-token: ${secret}\n  note: copy ${secret} here\n`;
    const out = redactFileForDisplay("plugins/Other/config.yml", unknown, { knownSecrets: [secret] }).content;
    expect(out).not.toContain(secret);
    expect(out).toContain("  api-token: **redacted**");
    expect(redactGenericLines("password = \"hunter2\"\nname = x")).toBe(`password = "${REDACTED}"\nname = x`);
    expect(redactFileForDisplay("custom.key", "abcdef123", { secretFiles: ["custom.key"] }).content).toBe(REDACTED);
  });

  it("random secrets in random positions never survive", () => {
    for (let i = 0; i < 50; i++) {
      const s = generateForwardingSecret();
      const doc = TomlDocument.parse("");
      doc.setValue("forwarding", "secret", s);
      const texts = [doc.toString(), maskYamlPaths(`allowed-tokens:\n- ${s}\n- other\n`, [["allowed-tokens"]], REDACTED)];
      expect(redactFileForDisplay("config/proxy-compatible-forge.toml", texts[0]!).content).not.toContain(s);
      expect(texts[1]).not.toContain(s);
    }
  });

  it("editYaml preserves unrelated comments when creating keys", () => {
    const r = editYaml("# header\nfoo: 1 # inline\nlist:\n- a\n", [{ path: ["proxies", "velocity", "enabled"], value: true }]);
    expect(r.content).toContain("# header");
    expect(r.content).toContain("foo: 1 # inline");
    expect(r.content).toContain("list:\n- a\n");
  });
});
