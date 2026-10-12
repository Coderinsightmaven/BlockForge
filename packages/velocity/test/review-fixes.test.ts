import { describe, expect, it } from "vitest";
import { parse as parseToml } from "smol-toml";
import { parse as parseYaml } from "yaml";
import { getProperty, parseProperties } from "@blockforge/minecraft";
import {
  BACKEND_FILES,
  TomlDocument,
  YamlEditError,
  backendForwardingFiles,
  conflictingExtensions,
  editYaml,
  forwardingCompatibility,
  generateForwardingSecret,
  redactFileForDisplay,
  writePaperVelocityConfig,
  writePcfConfig,
} from "../src/index.js";
import { DEFAULT_TOML, fixture } from "./helpers.js";

const secret = generateForwardingSecret();
const props = () => fixture("../../../minecraft/test/fixtures/properties/vanilla-26.3.server.properties");
const prop = (text: string, key: string) => getProperty(parseProperties(text), key);

describe("PCF / BungeeGuard / legacy transitions (review #8)", () => {
  const pcfModern = () => writePcfConfig(null, { mode: "MODERN", secret }).content;

  it("PCF modern → none writes forwarding.enabled = false and keeps the rest", () => {
    const r = backendForwardingFiles({ software: "neoforge", minecraftVersion: "1.21.1", mode: "none", secret: null, proxyOnlineMode: true, files: { [BACKEND_FILES.pcf]: pcfModern() } });
    const pcf = parseToml(r.files[BACKEND_FILES.pcf]!) as { forwarding: Record<string, unknown> };
    expect(pcf.forwarding).toEqual({ enabled: false, mode: "MODERN", secret });
  });

  it("PCF legacy → none on Forge, and none with PCF installed but no config yet", () => {
    const legacy = writePcfConfig(null, { mode: "LEGACY", secret: null }).content;
    const r = backendForwardingFiles({ software: "forge", minecraftVersion: "1.20.1", mode: "none", secret: null, proxyOnlineMode: true, files: { [BACKEND_FILES.pcf]: legacy } });
    expect((parseToml(r.files[BACKEND_FILES.pcf]!) as { forwarding: Record<string, unknown> }).forwarding.enabled).toBe(false);
    const fresh = backendForwardingFiles({ software: "forge", minecraftVersion: "1.20.1", mode: "none", secret: null, proxyOnlineMode: true, files: {}, installedExtensions: ["proxy-compatible-forge"] });
    expect(parseToml(fresh.files[BACKEND_FILES.pcf]!)).toEqual({ forwarding: { enabled: false } });
    const without = backendForwardingFiles({ software: "forge", minecraftVersion: "1.20.1", mode: "none", secret: null, proxyOnlineMode: true, files: {}, installedExtensions: [] });
    expect(without.files[BACKEND_FILES.pcf]).toBeUndefined();
  });

  it("PCF none → modern re-enables with the new secret; BungeeGuard mode writes the token", () => {
    const disabled = writePcfConfig(pcfModern(), { mode: null, secret: null }).content;
    const r = backendForwardingFiles({ software: "neoforge", minecraftVersion: "1.21.1", mode: "modern", secret, proxyOnlineMode: true, files: { [BACKEND_FILES.pcf]: disabled } });
    expect((parseToml(r.files[BACKEND_FILES.pcf]!) as { forwarding: Record<string, unknown> }).forwarding).toEqual({ enabled: true, mode: "MODERN", secret });
    const bg = backendForwardingFiles({ software: "forge", minecraftVersion: "1.20.1", mode: "bungeeguard", secret, proxyOnlineMode: true, files: {} });
    expect((parseToml(bg.files[BACKEND_FILES.pcf]!) as { forwarding: Record<string, unknown> }).forwarding).toEqual({ enabled: true, mode: "BUNGEEGUARD", secret });
    const paperBg = backendForwardingFiles({ software: "paper", minecraftVersion: "1.21.11", mode: "bungeeguard", secret, proxyOnlineMode: true, files: { "spigot.yml": fixture("spigot.representative.yml") } });
    expect(parseYaml(paperBg.files[BACKEND_FILES.bungeeGuard]!)["allowed-tokens"]).toEqual([secret]);
    expect(parseYaml(paperBg.files["spigot.yml"]!).settings.bungeecord).toBe(true);
  });

  it("Paper legacy → none and modern → none turn their switches off", () => {
    const spigotOn = fixture("spigot.representative.yml").replace("bungeecord: false", "bungeecord: true");
    const r = backendForwardingFiles({ software: "paper", minecraftVersion: "26.3", mode: "none", secret: null, proxyOnlineMode: true, files: { "spigot.yml": spigotOn } });
    expect(parseYaml(r.files["spigot.yml"]!).settings.bungeecord).toBe(false);
    const modernOn = writePaperVelocityConfig(fixture("paper-global.representative.yml"), "26.3", { enabled: true, onlineMode: true, secret }).content;
    const m = backendForwardingFiles({ software: "paper", minecraftVersion: "26.3", mode: "none", secret: null, proxyOnlineMode: true, files: { "config/paper-global.yml": modernOn } });
    expect(parseYaml(m.files["config/paper-global.yml"]!).proxies.velocity.enabled).toBe(false);
  });

  it("lists extensions that block a mode", () => {
    expect(conflictingExtensions("fabric", "none").map((e) => e.id)).toEqual(["fabricproxy-lite"]);
    expect(conflictingExtensions("fabric", "modern")).toEqual([]);
    expect(conflictingExtensions("paper", "modern").map((e) => e.id)).toEqual(["bungeeguard"]);
    expect(conflictingExtensions("paper", "bungeeguard")).toEqual([]);
    expect(forwardingCompatibility("fabric", "1.21.11").modes.modern.requiredExtensions.map((e) => e.id)).toEqual(["fabricproxy-lite", "fabric-api"]);
    expect(forwardingCompatibility("forge", "1.14.4").modes.modern.requiredExtensions.map((e) => e.id)).toEqual(["proxy-compatible-forge", "mixinbootstrap"]);
  });
});

describe("enforce-secure-profile per forwarding mode (review #9)", () => {
  const run = (mode: "modern" | "legacy" | "bungeeguard" | "none", version: string, forceKey = true, software: "paper" | "spigot" = "paper") =>
    backendForwardingFiles({ software, minecraftVersion: version, mode, secret: mode === "modern" || mode === "bungeeguard" ? secret : null, proxyOnlineMode: true, proxyForceKeyAuthentication: forceKey, files: { "server.properties": props() } });

  it("mirrors force-key-authentication for modern forwarding", () => {
    expect(run("modern", "26.3").files["server.properties"] ?? props()).toContain("enforce-secure-profile=true");
    expect(prop(run("modern", "26.3", false).files["server.properties"]!, "enforce-secure-profile")).toBe("false");
  });

  it("is off for legacy, BungeeGuard and no forwarding on 1.19+", () => {
    for (const mode of ["legacy", "bungeeguard", "none"] as const) {
      expect(prop(run(mode, "1.21.11", true, mode === "legacy" ? "spigot" : "paper").files["server.properties"]!, "enforce-secure-profile"), mode).toBe("false");
    }
  });

  it("is not written before 1.19", () => {
    const r = backendForwardingFiles({ software: "paper", minecraftVersion: "1.18.2", mode: "modern", secret, proxyOnlineMode: true, files: { "server.properties": "online-mode=true\n" } });
    expect(r.files["server.properties"]).toBe("online-mode=false\n");
  });
});

describe("byte-preserving YAML/TOML with BOM and CRLF (review #10, #11)", () => {
  const bomCrlf = (t: string) => "\uFEFF" + t.replace(/\r?\n/g, "\r\n");

  it("edits paper-global.yml in place with BOM + CRLF and never re-serialises", () => {
    const before = bomCrlf(fixture("paper-global.representative.yml"));
    const r = writePaperVelocityConfig(before, "26.3", { enabled: true, onlineMode: true, secret });
    expect(r.content.startsWith("\uFEFF# This is the global configuration file for Paper.\r\n")).toBe(true);
    expect(r.content.replace(/\r\n/g, "")).not.toContain("\n");
    const a = before.split("\r\n");
    const b = r.content.split("\r\n");
    expect(b).toHaveLength(a.length);
    expect(a.filter((l, i) => l !== b[i])).toEqual(["    enabled: false", "    secret: ''"]);
  });

  it("inserts missing keys as new lines (paper.yml without a velocity-support section)", () => {
    const before = bomCrlf("# paper.yml\nsettings:\n  timings: true # keep\n  other: 1\nworld-settings:\n  default: {}\n");
    const r = writePaperVelocityConfig(before, "1.18.2", { enabled: true, onlineMode: true, secret: "s" });
    expect(r.content).toBe(bomCrlf("# paper.yml\nsettings:\n  timings: true # keep\n  other: 1\n  velocity-support:\n    enabled: true\n    online-mode: true\n    secret: s\nworld-settings:\n  default: {}\n"));
  });

  it("fails closed instead of re-serialising", () => {
    expect(() => editYaml("settings: {a: 1}\n", [{ path: ["settings", "b"], value: true }])).toThrow(YamlEditError);
    expect(() => editYaml("settings: scalar\n", [{ path: ["settings", "b"], value: true }])).toThrow(YamlEditError);
  });

  it("parses, edits and redacts TOML with a UTF-8 BOM", () => {
    const text = bomCrlf(DEFAULT_TOML());
    const doc = TomlDocument.parse(text);
    expect(doc.toString()).toBe(text);
    expect(doc.get("", "config-version")).toBe("2.9");
    doc.setValue("", "bind", "0.0.0.0:25577");
    const out = doc.toString();
    expect(out.startsWith("\uFEFF# Config version.")).toBe(true);
    expect(out.replace(/\r\n/g, "")).not.toContain("\n");
    expect(parseToml(out.slice(1))).toMatchObject({ bind: "0.0.0.0:25577" });
    const fpl = "\uFEFFsecret = \"" + secret + "\"\r\n";
    expect(redactFileForDisplay("config/FabricProxy-Lite.toml", fpl).content).toBe("\uFEFFsecret = \"**redacted**\"\r\n");
  });
});
