import { describe, expect, it } from "vitest";
import { extensionIdentityKey, flagDuplicateExtensions, jarCompatibility, parseJarMetadata, parseModsToml, type DuplicateCheckJar } from "../src/index.js";

const pluginYml = (name: string) => `name: ${name}\nversion: 1.0\nmain: x.Main\n`;
const paperYml = (name: string) => `name: ${name}\nversion: 1.0\nmain: x.Main\napi-version: "1.21"\n`;
const fabricJson = (id: string) => JSON.stringify({ schemaVersion: 1, id, version: "1.0.0", environment: "*" });

/** A jar of the install dir as the control plane builds it (parsed metadata + its own compatibility). */
function jar(path: string, entries: Record<string, string>, software: Parameters<typeof jarCompatibility>[1], enabled = !path.endsWith(".disabled")): DuplicateCheckJar {
  const parsed = parseJarMetadata(entries);
  return { path, enabled, metadata: parsed.extensions, compatibility: jarCompatibility(parsed, software) };
}

describe("flagDuplicateExtensions", () => {
  it("flags both copies of one Paper plugin (file-manager copy) with a DUPLICATE_ID warning naming the other", () => {
    const a = jar("plugins/Chunky-1.4.40.jar", { "plugin.yml": pluginYml("Chunky") }, "paper");
    const b = jar("plugins/Chunky-1.4.40 (copy).jar", { "plugin.yml": pluginYml("Chunky") }, "paper");
    const c = jar("plugins/LuckPerms.jar", { "plugin.yml": pluginYml("LuckPerms") }, "paper");
    const out = flagDuplicateExtensions([a, b, c]);
    expect([...out.keys()].sort()).toEqual([a.path, b.path].sort());
    expect(out.get(a.path)).toEqual({
      loadable: true,
      metadataIndex: 0,
      problems: [
        { code: "DUPLICATE_ID", level: "warning", message: 'plugins/Chunky-1.4.40 (copy).jar declares the same plugin name "Chunky"; the server loads only one of them' },
      ],
    });
    expect(out.get(b.path)!.problems[0]!.message).toContain("plugins/Chunky-1.4.40.jar");
  });

  it("compares plugin names case-insensitively, spaces as underscores, across plugin.yml and paper-plugin.yml", () => {
    const a = jar("plugins/a.jar", { "plugin.yml": pluginYml("My Plugin") }, "paper");
    const b = jar("plugins/b.jar", { "paper-plugin.yml": paperYml("my_plugin") }, "paper");
    const c = jar("plugins/c.jar", { "plugin.yml": pluginYml("MY_PLUGIN") }, "paper");
    const out = flagDuplicateExtensions([a, b, c]);
    expect(out.size).toBe(3);
    expect(out.get(a.path)!.problems[0]!.message).toBe('plugins/b.jar, plugins/c.jar declares the same plugin name "My Plugin"; the server loads only one of them');
    expect(extensionIdentityKey("bukkit", "My Plugin")).toBe("my_plugin");
    expect(extensionIdentityKey("fabric", "my mod")).toBe("my mod");
  });

  it("ignores disabled jars, unread jars and jars the server would not load", () => {
    const a = jar("plugins/Chunky.jar", { "plugin.yml": pluginYml("Chunky") }, "paper");
    const disabled = jar("plugins/Chunky-old.jar.disabled", { "plugin.yml": pluginYml("Chunky") }, "paper");
    const unread: DuplicateCheckJar = { ...a, path: "plugins/unread.jar", compatibility: null };
    const wrong = jar("plugins/fabric.jar", { "fabric.mod.json": fabricJson("chunky") }, "paper");
    const folia = jar("plugins/Chunky-folia.jar", { "plugin.yml": pluginYml("Chunky") }, "folia");
    expect(folia.compatibility!.loadable).toBe(false);
    expect(flagDuplicateExtensions([a, disabled, unread, wrong, folia]).size).toBe(0);
  });

  it("duplicate Fabric mod ids are an error on both jars (the loader refuses to start)", () => {
    const a = jar("mods/sodium-0.6.jar", { "fabric.mod.json": fabricJson("sodium") }, "fabric");
    const b = jar("mods/sodium-0.5.jar", { "fabric.mod.json": fabricJson("sodium") }, "fabric");
    const out = flagDuplicateExtensions([a, b]);
    for (const p of [a.path, b.path]) {
      expect(out.get(p)!.loadable).toBe(false);
      expect(out.get(p)!.problems).toEqual([expect.objectContaining({ code: "DUPLICATE_ID", level: "error" })]);
    }
    expect(out.get(a.path)!.problems[0]!.message).toBe('mods/sodium-0.5.jar declares the same mod id "sodium"; the server refuses to start with duplicate mod ids');
  });

  it("checks every mod of a multi-mod Forge jar and keeps existing problems after the duplicate", () => {
    const multi = `modLoader="javafml"\nloaderVersion="[47,)"\n[[mods]]\nmodId="alpha"\nversion="1.0"\n[[mods]]\nmodId="beta"\nversion="1.0"\n`;
    const single = `modLoader="javafml"\nloaderVersion="[47,)"\n[[mods]]\nmodId="beta"\nversion="2.0"\n`;
    expect(parseModsToml(multi).map((m) => m.id)).toEqual(["alpha", "beta"]);
    const a = jar("mods/pack.jar", { "META-INF/mods.toml": multi }, "neoforge");
    const b = jar("mods/beta.jar", { "META-INF/mods.toml": single }, "neoforge");
    const out = flagDuplicateExtensions([a, b]);
    expect(out.get(a.path)!.problems.map((p) => p.code)).toEqual(["DUPLICATE_ID", "LEGACY_MODS_TOML"]);
    expect(out.get(a.path)!.problems[0]!.message).toContain('mod id "beta"');
    expect(out.get(b.path)!.problems[0]!.message).toBe('mods/pack.jar declares the same mod id "beta"; the server refuses to start with duplicate mod ids');
  });

  it("caps the problem list at 32 with the duplicate kept", () => {
    const many = jar("plugins/a.jar", { "plugin.yml": pluginYml("A") }, "paper");
    many.compatibility!.problems = Array.from({ length: 32 }, () => ({ code: "METADATA_WARNING" as const, level: "warning" as const, message: "w" }));
    const out = flagDuplicateExtensions([many, jar("plugins/b.jar", { "plugin.yml": pluginYml("a") }, "paper")]);
    expect(out.get("plugins/a.jar")!.problems).toHaveLength(32);
    expect(out.get("plugins/a.jar")!.problems[0]!.code).toBe("DUPLICATE_ID");
  });
});
