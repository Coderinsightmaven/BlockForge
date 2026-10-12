import { describe, expect, it } from "vitest";
import {
  ExtensionMetadataError,
  extensionDirFor,
  jarCompatibility,
  parseBungeeYml,
  parseFabricModJson,
  parseJarManifest,
  parseJarMetadata,
  parseModsToml,
  parsePaperPluginYml,
  parsePluginYml,
  parseQuiltModJson,
  parseVelocityPluginJson,
  selectExtensionFiles,
  toggledExtensionPath,
} from "../src/index.js";
import { fixture } from "./helpers.js";

const ext = (name: string) => fixture(`extensions/${name}`);

describe("plugin.yml (real files from Modrinth jars)", () => {
  it("LuckPerms Bukkit 5.5.71", () => {
    const m = parsePluginYml(ext("luckperms-bukkit-5.5.71.plugin.yml"));
    expect(m).toMatchObject({
      format: "bukkit",
      id: "LuckPerms",
      name: "LuckPerms",
      version: "5.5.71",
      description: "A permissions plugin",
      authors: ["Luck"],
      minecraftVersion: "1.13",
      foliaSupported: true,
      entrypoint: "me.lucko.luckperms.bukkit.loader.BukkitLoaderPlugin",
      homepage: "https://luckperms.net/",
      libraries: [],
      warnings: [],
    });
    expect(m.dependencies).toEqual([
      { id: "LilyPad-Connect", kind: "optional", versionRange: null, side: null },
      { id: "ViaVersion", kind: "optional", versionRange: null, side: null },
      { id: "Vault", kind: "load-before", versionRange: null, side: null },
    ]);
  });

  it("WorldGuard 7.0.17 depends on WorldEdit; quoted versions kept verbatim", () => {
    const m = parsePluginYml(ext("worldguard-bukkit-7.0.17.plugin.yml"));
    expect(m.version).toBe("7.0.17+2370-e42d8bc");
    expect(m.minecraftVersion).toBe("1.21.11");
    expect(m.dependencies).toEqual([{ id: "WorldEdit", kind: "required", versionRange: null, side: null }]);
  });

  it("Chunky 1.4.40 and squaremap 1.3.12 (block lists, unquoted api-version)", () => {
    const chunky = parsePluginYml(ext("chunky-bukkit-1.4.40.plugin.yml"));
    expect(chunky.dependencies.map((d) => `${d.kind}:${d.id}`)).toEqual(["optional:dynmap", "optional:BlueMap", "optional:squaremap", "optional:WorldBorder"]);
    expect(chunky.homepage).toBe("https://www.spigotmc.org/resources/chunky.81534/");
    const squaremap = parsePluginYml(ext("squaremap-paper-1.3.12.plugin.yml"));
    expect(squaremap).toMatchObject({ authors: ["jmp"], minecraftVersion: "1.21.11", foliaSupported: true });
  });

  it("keeps YAML numbers as written (1.10 is not 1.1)", () => {
    const m = parsePluginYml("name: X\nversion: 1.10\nmain: a.B\napi-version: 1.20\nlibraries:\n  - com.example:lib:1.0\n");
    expect(m.version).toBe("1.10");
    expect(m.minecraftVersion).toBe("1.20");
    expect(m.libraries).toEqual(["com.example:lib:1.0"]);
    expect(m.warnings.join(" ")).toContain("Maven Central");
  });

  it("rejects malformed or hostile documents without side effects", () => {
    expect(() => parsePluginYml("version: 1\n")).toThrow(ExtensionMetadataError);
    expect(() => parsePluginYml("- a\n- b\n")).toThrow(ExtensionMetadataError);
    expect(() => parsePluginYml("name: [unclosed\n")).toThrow(ExtensionMetadataError);
    expect(() => parsePluginYml("x".repeat(300 * 1024))).toThrow(/too large/);
    const bomb = ["a: &a [x, x, x, x, x, x, x, x, x]", ..."bcdefghij".split("").map((k, i) => `${k}: &${k} [*${"abcdefghij"[i]}, *${"abcdefghij"[i]}, *${"abcdefghij"[i]}, *${"abcdefghij"[i]}]`), "name: X"].join("\n");
    expect(() => parsePluginYml(bomb)).toThrow(/aliases expand/);
    const m = parsePluginYml("name: X\n__proto__:\n  polluted: true\nconstructor: 1\nwebsite: javascript:alert(1)\n");
    expect(({} as Record<string, unknown>)["polluted"]).toBeUndefined();
    expect(m.homepage).toBeNull();
    const ctl = parsePluginYml('name: "Evil\\u0007\\u001b[31mName"\nmain: a.B\nversion: 1\n');
    expect(ctl.name).toBe("Evil[31mName");
  });
});

describe("paper-plugin.yml (real files)", () => {
  it("FancyHolograms 3.0.0-SNAPSHOT.90: server dependencies, all optional", () => {
    const m = parsePaperPluginYml(ext("fancyholograms-3.0.0-SNAPSHOT.90.paper-plugin.yml"));
    expect(m).toMatchObject({ format: "paper", id: "FancyHolograms", version: "3.0.0-SNAPSHOT.90", minecraftVersion: "1.19", foliaSupported: true, warnings: [] });
    expect(m.dependencies.map((d) => `${d.kind}:${d.id}`)).toEqual([
      "optional:FancyNpcs",
      "optional:Geyser-Spigot",
      "optional:MiniPlaceholders",
      "optional:PlaceholderAPI",
      "optional:ViaVersion",
      "optional:floodgate",
    ]);
  });

  it("FancyNpcs 2.12.1+379", () => {
    const m = parsePaperPluginYml(ext("fancynpcs-2.12.1.paper-plugin.yml"));
    expect(m.version).toBe("2.12.1+379");
    expect(m.dependencies.map((d) => d.id)).toEqual(["Citizens", "MiniPlaceholders", "PlaceholderAPI", "PlotSquared"]);
  });

  it("required defaults to true; AFTER means load-before; bootstrap deps included", () => {
    const m = parsePaperPluginYml(
      "name: P\nversion: '1'\nmain: a.B\napi-version: '1.21'\ndependencies:\n  server:\n    Vault: {}\n    Later:\n      load: AFTER\n      required: false\n  bootstrap:\n    Boot:\n      required: true\n",
    );
    expect(m.dependencies.map((d) => `${d.kind}:${d.id}`)).toEqual(["required:Vault", "load-before:Later", "required:Boot"]);
  });
});

describe("velocity-plugin.json, bungee.yml, fabric.mod.json, quilt.mod.json", () => {
  it("LuckPerms Velocity 5.5.71", () => {
    expect(parseVelocityPluginJson(ext("luckperms-velocity-5.5.71.velocity-plugin.json"))).toMatchObject({
      format: "velocity",
      id: "luckperms",
      name: "LuckPerms",
      version: "5.5.71",
      authors: ["Luck"],
      dependencies: [],
      entrypoint: "me.lucko.luckperms.velocity.LPVelocityBootstrap",
      homepage: "https://luckperms.net/",
    });
    const m = parseVelocityPluginJson('{"id":"x","dependencies":[{"id":"luckperms","optional":true},{"id":"geyser"}]}');
    expect(m.dependencies.map((d) => `${d.kind}:${d.id}`)).toEqual(["optional:luckperms", "required:geyser"]);
  });

  it("Ledger 1.3.5: server-only, depends + breaks", () => {
    const m = parseFabricModJson(ext("ledger-1.3.5.fabric.mod.json"));
    expect(m).toMatchObject({
      format: "fabric",
      id: "ledger",
      name: "Ledger",
      version: "1.3.5",
      environment: "server",
      minecraftVersion: ">=1.21",
      loaderVersion: ">=0.15.10",
      license: "LGPL",
      entrypoint: "com.github.quiltservertools.ledger.Ledger::INSTANCE",
      homepage: "https://quiltservertools.github.io/Ledger/latest/",
      bundledJars: ["META-INF/jars/fabric-permissions-api-0.3.1.jar", "META-INF/jars/server-translations-api-2.3.1+1.21-pre2.jar"],
      warnings: [],
    });
    expect(m.dependencies).toEqual([
      { id: "fabric", kind: "required", versionRange: ">=0.100.1+1.21", side: null },
      { id: "fabric-language-kotlin", kind: "required", versionRange: ">=1.11.0+kotlin.2.0.0", side: null },
      { id: "cardboard", kind: "incompatible", versionRange: "*", side: null },
    ]);
  });

  it("FabricProxy-Lite 2.10.1", () => {
    const m = parseFabricModJson(ext("fabricproxy-lite-2.10.1.fabric.mod.json"));
    expect(m).toMatchObject({ id: "fabricproxy-lite", environment: "server", entrypoint: "one.oktw.FabricProxyLite", minecraftVersion: ">=1.21", loaderVersion: ">=0.16.14" });
    expect(m.dependencies.map((d) => d.id)).toEqual(["fabric-networking-api-v1", "fabric-api"]);
  });

  it("client-only Fabric mods, array ranges, authors objects, schema 0", () => {
    const m = parseFabricModJson('{"id":"c","environment":"client","authors":[{"name":"A"},"B"],"depends":{"minecraft":["1.20.1","1.20.2"]},"suggests":{"x":"*"}}');
    expect(m.environment).toBe("client");
    expect(m.authors).toEqual(["A", "B"]);
    expect(m.minecraftVersion).toBe("1.20.1 || 1.20.2");
    expect(m.dependencies).toEqual([{ id: "x", kind: "optional", versionRange: "*", side: null }]);
    expect(m.warnings).toEqual(["fabric.mod.json schemaVersion 0 is outdated"]); // client-only is reported by jarCompatibility (CLIENT_ONLY)
    expect(() => parseFabricModJson("{not json")).toThrow(ExtensionMetadataError);
    expect(() => parseFabricModJson("[]")).toThrow(ExtensionMetadataError);
    expect(() => parseFabricModJson('{"name":"no id"}')).toThrow(ExtensionMetadataError);
  });

  it("bungee.yml and quilt.mod.json are identified (for upload validation)", () => {
    expect(parseBungeeYml("name: B\nmain: a.B\nversion: 2\ndepends: [X]\n")).toMatchObject({ format: "bungeecord", dependencies: [{ id: "X", kind: "required" }] });
    expect(parseQuiltModJson('{"schema_version":1,"quilt_loader":{"id":"q","version":"1.0","metadata":{"name":"Q"}}}')).toMatchObject({ format: "quilt", id: "q", name: "Q" });
  });
});

describe("mods.toml / neoforge.mods.toml (real files)", () => {
  it("FerriteCore 6.0.1 Forge: ${file.jarVersion} resolved from the real MANIFEST.MF", () => {
    const manifest = parseJarManifest(ext("ferritecore-6.0.1-forge.MANIFEST.MF"));
    expect(manifest["Implementation-Version"]).toBe("6.0.1");
    expect(manifest["MixinConfigs"]).toBe(
      "ferritecore.predicates.mixin.json,ferritecore.fastmap.mixin.json,ferritecore.mrl.mixin.json,ferritecore.dedupmultipart.mixin.json,ferritecore.blockstatecache.mixin.json,ferritecore.dedupbakedquad.mixin.json,ferritecore.threaddetec.mixin.json,ferritecore.modelsides.mixin.json",
    );
    expect(Object.keys(manifest)).not.toContain("Name"); // per-entry sections are ignored
    const [m] = parseModsToml(ext("ferritecore-6.0.1-forge.mods.toml"), { manifest });
    expect(m).toMatchObject({
      format: "forge",
      id: "ferritecore",
      name: "Ferrite Core",
      version: "6.0.1",
      description: "Reduces memory usage.",
      authors: ["malte0811"],
      license: "MIT",
      minecraftVersion: "[1.20,1.21)",
      loaderVersion: "javafml [28,); forge [46.0.1,)",
      dependencies: [],
      warnings: [],
    });
    const [unresolved] = parseModsToml(ext("ferritecore-6.0.1-forge.mods.toml"));
    expect(unresolved!.version).toBe("${file.jarVersion}");
    expect(unresolved!.warnings[0]).toMatch(/manifest/);
  });

  it("FerriteCore 7.0.3 NeoForge (type = required) and spark (mandatory = true, root authors)", () => {
    const [neo] = parseModsToml(ext("ferritecore-7.0.3.neoforge.mods.toml"), { neoforge: true });
    expect(neo).toMatchObject({ format: "neoforge", version: "7.0.3", minecraftVersion: "[1.21.1,1.22)", loaderVersion: "javafml [1,); neoforge [21.1.218,)" });
    const [spark] = parseModsToml(ext("spark-1.10.124.neoforge.mods.toml"), { neoforge: true });
    expect(spark).toMatchObject({ id: "spark", version: "1.10.124", authors: ["Luck"], license: "GPLv3", loaderVersion: "javafml [2,); neoforge [20,)" });
    const [sparkForge] = parseModsToml(ext("spark-1.10.53-forge.mods.toml"));
    expect(sparkForge).toMatchObject({ format: "forge", id: "spark", loaderVersion: "javafml [34,); forge [34,)", minecraftVersion: null });
  });

  it("dependency types, sides and multiple [[mods]]", () => {
    const toml = [
      'modLoader="javafml"', 'loaderVersion="[1,)"', 'license="MIT"',
      "[[mods]]", 'modId="a"', 'version="1"', "[[mods]]", 'modId="b"', 'version="2"',
      "[[dependencies.a]]", 'modId="jei"', 'type="optional"', 'side="CLIENT"',
      "[[dependencies.a]]", 'modId="optifine"', 'type="incompatible"',
      "[[dependencies.a]]", 'modId="old"', "mandatory=false",
      "[[dependencies.b]]", 'modId="a"', 'type="required"', 'versionRange="[1,)"',
    ].join("\n");
    const [a, b] = parseModsToml(toml, { neoforge: true });
    expect(a!.dependencies).toEqual([
      { id: "jei", kind: "optional", versionRange: null, side: "client" },
      { id: "optifine", kind: "incompatible", versionRange: null, side: "both" },
      { id: "old", kind: "optional", versionRange: null, side: "both" },
    ]);
    expect(b!.dependencies).toEqual([{ id: "a", kind: "required", versionRange: "[1,)", side: "both" }]);
    expect(() => parseModsToml("modLoader=")).toThrow(ExtensionMetadataError);
    expect(() => parseModsToml('license="x"')).toThrow(/no \[\[mods\]\]/);
    parseModsToml('[[mods]]\nmodId="p"\n[__proto__]\npolluted=true\n');
    expect(({} as Record<string, unknown>)["polluted"]).toBeUndefined();
  });
});

describe("jar-level parsing and compatibility", () => {
  const luckpermsBukkit = parseJarMetadata({ "plugin.yml": ext("luckperms-bukkit-5.5.71.plugin.yml") }).extensions;
  const fancy = parseJarMetadata({ "paper-plugin.yml": ext("fancyholograms-3.0.0-SNAPSHOT.90.paper-plugin.yml") }).extensions;
  const ledger = parseJarMetadata({ "fabric.mod.json": ext("ledger-1.3.5.fabric.mod.json") }).extensions;
  const ferriteForge = parseJarMetadata({
    "META-INF/mods.toml": ext("ferritecore-6.0.1-forge.mods.toml"),
    "META-INF/MANIFEST.MF": ext("ferritecore-6.0.1-forge.MANIFEST.MF"),
  }).extensions;
  const ferriteNeo = parseJarMetadata({ "META-INF/neoforge.mods.toml": ext("ferritecore-7.0.3.neoforge.mods.toml") }).extensions;
  const worldguard = parseJarMetadata({ "plugin.yml": ext("worldguard-bukkit-7.0.17.plugin.yml") }).extensions;

  it("reads every entry; manifest resolves the Forge version; errors are collected", () => {
    expect(ferriteForge[0]!.version).toBe("6.0.1");
    const r = parseJarMetadata({ "plugin.yml": "name: [", "fabric.mod.json": ext("ledger-1.3.5.fabric.mod.json") });
    expect(r.extensions.map((e) => e.id)).toEqual(["ledger"]);
    expect(r.errors[0]).toMatch(/^plugin\.yml: invalid YAML/);
    expect(parseJarMetadata(JSON.parse('{"__proto__":"x"}') as Record<string, string>).extensions).toEqual([]);
  });

  it.each([
    ["paper", "luckperms", true],
    ["spigot", "luckperms", true],
    ["folia", "luckperms", true],
    ["paper", "fancy", true],
    ["spigot", "fancy", false],
    ["velocity", "luckperms", false],
    ["fabric", "ledger", true],
    ["forge", "ledger", false],
    ["forge", "ferriteForge", true],
    ["neoforge", "ferriteNeo", true],
    ["neoforge", "ferriteForge", true],
    ["forge", "ferriteNeo", false],
    ["vanilla", "luckperms", false],
  ] as const)("%s loads %s → %s", (software, which, loadable) => {
    const map = { luckperms: luckpermsBukkit, fancy, ledger, ferriteForge, ferriteNeo };
    expect(jarCompatibility(map[which], software).loadable).toBe(loadable);
  });

  it("explains incompatibilities with structured problem codes", () => {
    expect(jarCompatibility(ledger, "paper")).toEqual({
      loadable: false,
      metadataIndex: null,
      problems: [{ code: "WRONG_PLATFORM", level: "error", message: "built for fabric, not for paper" }],
    });
    expect(jarCompatibility([], "paper").problems).toEqual([{ code: "NO_METADATA", level: "error", message: "no plugin or mod metadata found in the jar" }]);
    expect(jarCompatibility(luckpermsBukkit, "vanilla")).toMatchObject({ loadable: false, problems: [{ code: "NO_EXTENSION_DIR", level: "error" }] });
    expect(jarCompatibility(ferriteForge, "neoforge")).toMatchObject({ loadable: true, metadataIndex: 0, problems: [{ code: "LEGACY_MODS_TOML", level: "warning" }] });
    const noFolia = parsePluginYml("name: X\nmain: a.B\nversion: 1\n");
    expect(jarCompatibility([noFolia], "folia")).toMatchObject({ loadable: false, metadataIndex: 0, problems: [{ code: "FOLIA_UNSUPPORTED", level: "error" }] });
    expect(jarCompatibility(worldguard, "folia")).toEqual({ loadable: true, metadataIndex: 0, problems: [] });
    const client = parseFabricModJson('{"schemaVersion":1,"id":"c","environment":"client"}');
    expect(jarCompatibility([client], "fabric").problems.map((p) => `${p.code}:${p.level}`)).toEqual(["CLIENT_ONLY:warning"]);
  });

  it("unreadable metadata: an error when it is the file the server reads first, a warning otherwise", () => {
    // Paper reads paper-plugin.yml before plugin.yml: a broken paper-plugin.yml makes the jar unloadable.
    const brokenPaper = parseJarMetadata({ "paper-plugin.yml": "name: [", "plugin.yml": ext("luckperms-bukkit-5.5.71.plugin.yml") });
    expect(jarCompatibility(brokenPaper, "paper")).toMatchObject({ loadable: false, metadataIndex: 0, problems: [{ code: "METADATA_INVALID", level: "error" }] });
    // Spigot never reads paper-plugin.yml: only a warning there.
    expect(jarCompatibility(brokenPaper, "spigot")).toMatchObject({ loadable: true, metadataIndex: 0, problems: [{ code: "METADATA_INVALID", level: "warning" }] });
    // A broken file for another platform next to valid metadata: warning.
    const mixed = parseJarMetadata({ "plugin.yml": "name: [", "fabric.mod.json": ext("ledger-1.3.5.fabric.mod.json") });
    expect(jarCompatibility(mixed, "fabric")).toMatchObject({ loadable: true, problems: [{ code: "METADATA_INVALID", level: "warning" }] });
    expect(mixed.invalid).toEqual([{ entry: "plugin.yml", format: "bukkit", message: expect.stringMatching(/^invalid YAML/) }]);
    // Only broken metadata of the server's own format: METADATA_INVALID error, no extra NO_METADATA.
    expect(jarCompatibility(parseJarMetadata({ "fabric.mod.json": "{" }), "fabric").problems).toEqual([
      { code: "METADATA_INVALID", level: "error", message: "fabric.mod.json: fabric.mod.json is not valid JSON" },
    ]);
  });
});

describe("installed extension scan", () => {
  it("selects jars from a plugins/ listing and skips everything unsafe", () => {
    const listing = [
      { name: "LuckPerms-Bukkit-5.5.71.jar", type: "file" as const, size: 1501521 },
      { name: "WorldEdit.jar.disabled", type: "file" as const, size: 10 },
      { name: "LuckPerms", type: "dir" as const, size: 0 },
      { name: "evil.jar", type: "symlink" as const, size: 10 },
      { name: "empty.jar", type: "file" as const, size: 0 },
      { name: "config.yml", type: "file" as const, size: 10 },
      { name: ".hidden.jar", type: "file" as const, size: 10 },
      { name: "folder.jar", type: "dir" as const, size: 0 },
    ];
    const r = selectExtensionFiles("plugins", listing);
    expect(r.files).toEqual([
      { path: "plugins/LuckPerms-Bukkit-5.5.71.jar", name: "LuckPerms-Bukkit-5.5.71.jar", sizeBytes: 1501521, enabled: true },
      { path: "plugins/WorldEdit.jar.disabled", name: "WorldEdit.jar.disabled", sizeBytes: 10, enabled: false },
    ]);
    expect(r.skipped).toEqual([
      { name: "evil.jar", reason: "symlink" },
      { name: "empty.jar", reason: "empty" },
      { name: "config.yml", reason: "not-a-jar" },
      { name: ".hidden.jar", reason: "unsafe-name" },
      { name: "folder.jar", reason: "not-a-file" },
    ]);
  });

  it("maps software to the extension directory and toggles jars", () => {
    expect(extensionDirFor("paper")).toBe("plugins");
    expect(extensionDirFor("velocity")).toBe("plugins");
    expect(extensionDirFor("neoforge")).toBe("mods");
    expect(extensionDirFor("vanilla")).toBeNull();
    expect(toggledExtensionPath("mods/a.jar", false)).toBe("mods/a.jar.disabled");
    expect(toggledExtensionPath("mods/a.jar.disabled", true)).toBe("mods/a.jar");
    expect(toggledExtensionPath("mods/a.jar", true)).toBeNull();
    expect(toggledExtensionPath("mods/a.jar.disabled", false)).toBeNull();
    expect(toggledExtensionPath("mods/readme.txt", false)).toBeNull();
  });
});
