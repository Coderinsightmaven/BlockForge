import { describe, expect, it } from "vitest";
import {
  AGENT_COMMANDS,
  ApplyExtensionUpdatesRequest,
  BanIpAddress,
  ExtensionUpdatesQuery,
  ExtensionUploadRequest,
  InstalledExtension,
  ModrinthInstallRequest,
  ModrinthPlannedFile,
  ModrinthPlanRequest,
  ModrinthSearchQuery,
  PlanWarningCode,
  PlayerActionRequest,
  PlayerUuid,
  REALTIME_EVENT_PAYLOADS,
  RateLimitedErrorDetails,
  ZipEntryName,
  isSafeJarFilename,
  redactCommandPayload,
} from "../src/index.js";

const WID = "1a2b3c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d";
const SHA1 = "a".repeat(40);
const SHA512 = "b".repeat(128);

describe("agent fs.hash / jar.readEntries", () => {
  it.each(["plugin.yml", "META-INF/mods.toml", "META-INF/neoforge.mods.toml", "a b/c.txt"])("ZipEntryName accepts %j", (n) => {
    expect(ZipEntryName.safeParse(n).success).toBe(true);
  });
  it.each(["", "../plugin.yml", "a/../b", "/plugin.yml", "a//b", "./a", "dir/", "a\\b", "a\0b", "a\nb", "x".repeat(256)])(
    "ZipEntryName rejects %j",
    (n) => {
      expect(ZipEntryName.safeParse(n).success).toBe(false);
    },
  );

  it("fs.hash bounds its payload and defaults the total budget", () => {
    const p = AGENT_COMMANDS["fs.hash"].payload;
    const ok = p.parse({ workloadId: WID, paths: ["plugins/a.jar"], algorithms: ["sha512"], maxBytesPerFile: 1024 });
    expect(ok.maxTotalBytes).toBe(16 * 1024 ** 3);
    expect(p.safeParse({ workloadId: WID, paths: ["a"], algorithms: ["sha1", "sha1"], maxBytesPerFile: 1 }).success).toBe(false);
    expect(p.safeParse({ workloadId: WID, paths: ["a"], algorithms: ["md5"], maxBytesPerFile: 1 }).success).toBe(false);
    expect(p.safeParse({ workloadId: WID, paths: ["a"], algorithms: ["sha1"], maxBytesPerFile: 2 * 1024 ** 3 + 1 }).success).toBe(false);
    expect(p.safeParse({ workloadId: WID, paths: Array(513).fill("a"), algorithms: ["sha1"], maxBytesPerFile: 1 }).success).toBe(false);
    expect(p.safeParse({ workloadId: WID, paths: ["../x"], algorithms: ["sha1"], maxBytesPerFile: 1 }).success).toBe(false);
  });

  it("fs.hash results are per file and need lowercase digests of the right length", () => {
    const r = AGENT_COMMANDS["fs.hash"].result;
    expect(r.safeParse({ files: [{ ok: true, path: "a", sizeBytes: 1, mtime: 1, sha1: SHA1 }] }).success).toBe(true);
    expect(r.safeParse({ files: [{ ok: true, path: "a", sizeBytes: 1, mtime: 1, sha1: SHA1.toUpperCase() }] }).success).toBe(false);
    expect(r.safeParse({ files: [{ ok: true, path: "a", sizeBytes: 1, mtime: 1, sha512: SHA1 }] }).success).toBe(false);
    expect(r.safeParse({ files: [{ ok: false, path: "a", error: "BUDGET_EXCEEDED" }] }).success).toBe(true);
    expect(r.safeParse({ files: [{ ok: false, path: "a", error: "EVERYTHING_FAILED" }] }).success).toBe(false);
  });

  it("jar.readEntries caps decompression and the total budget", () => {
    const p = AGENT_COMMANDS["jar.readEntries"].payload;
    const base = { workloadId: WID, paths: ["plugins/a.jar"], entries: ["plugin.yml"], maxEntryBytes: 256 * 1024, maxJarBytes: 1024 };
    const ok = p.parse(base);
    expect(ok.hash).toEqual([]);
    expect(ok.maxTotalBytes).toBe(4 * 1024 * 1024);
    expect(p.safeParse({ ...base, maxEntryBytes: 256 * 1024 + 1 }).success).toBe(false);
    expect(p.safeParse({ ...base, maxTotalBytes: 8 * 1024 * 1024 + 1 }).success).toBe(false);
    expect(p.safeParse({ ...base, entries: ["plugin.yml", "plugin.yml"] }).success).toBe(false);
    expect(p.safeParse({ ...base, hash: ["sha256"] }).success).toBe(false);
  });

  it("neither command is redacted (no secrets in their payloads)", () => {
    const payload = { workloadId: WID, paths: ["plugins/a.jar"] };
    expect(redactCommandPayload("fs.hash", payload)).toEqual(payload);
    expect(redactCommandPayload("jar.readEntries", payload)).toEqual(payload);
  });
});

describe("extensions API", () => {
  it.each(["LuckPerms-Bukkit-5.5.17.jar", "fabric-api-0.119.2+1.21.8.jar", "Vault.JAR"])("accepts jar name %j", (n) => {
    expect(isSafeJarFilename(n)).toBe(true);
  });
  it.each(["CON.jar", "nul.txt.jar", "com1.jar", ".hidden.jar", "a/b.jar", "a\\b.jar", "x.jar ", "x.jar.", "evil‮jar.jar", "x.zip", ".jar"])(
    "rejects jar name %j",
    (n) => {
      expect(isSafeJarFilename(n)).toBe(false);
    },
  );

  const file = {
    action: "install",
    reason: "requested",
    requiredBy: [],
    projectId: "Vebnzrzj",
    projectSlug: "luckperms",
    projectTitle: "LuckPerms",
    versionId: "OrIs0S6b",
    versionNumber: "v5.5.17-bukkit",
    versionType: "release",
    loaders: ["bukkit", "folia", "paper", "spigot"],
    filename: "LuckPerms-Bukkit-5.5.17.jar",
    url: "https://cdn.modrinth.com/data/Vebnzrzj/versions/OrIs0S6b/LuckPerms-Bukkit-5.5.17.jar",
    sizeBytes: 1503210,
    sha1: SHA1,
    sha512: SHA512,
    destPath: "plugins/LuckPerms-Bukkit-5.5.17.jar",
    replaces: [],
  };
  it("planned files are SHA-512, CDN-only and land in the install dir under their own name", () => {
    expect(ModrinthPlannedFile.safeParse(file).success).toBe(true);
    expect(ModrinthPlannedFile.safeParse({ ...file, sha512: null }).success).toBe(false);
    expect(ModrinthPlannedFile.safeParse({ ...file, url: "http://cdn.modrinth.com/data/x.jar" }).success).toBe(false);
    expect(ModrinthPlannedFile.safeParse({ ...file, url: "https://cdn.modrinth.com:8443/data/x.jar" }).success).toBe(false);
    expect(ModrinthPlannedFile.safeParse({ ...file, url: "https://evil.example/cdn.modrinth.com/x.jar" }).success).toBe(false);
    expect(ModrinthPlannedFile.safeParse({ ...file, url: "https://user:pw@cdn.modrinth.com/x.jar" }).success).toBe(false);
    expect(ModrinthPlannedFile.safeParse({ ...file, destPath: "plugins/Other.jar" }).success).toBe(false);
    expect(ModrinthPlannedFile.safeParse({ ...file, destPath: "config/LuckPerms-Bukkit-5.5.17.jar" }).success).toBe(false);
    expect("checksum" in ModrinthPlannedFile.parse({ ...file, checksum: { algorithm: "sha1", value: SHA1 } })).toBe(false);
  });

  it("plan/install requests are strict, default to stable releases and require an expectation", () => {
    const plan = ModrinthPlanRequest.parse({ project: "luckperms" });
    expect(plan).toEqual({ project: "luckperms", includeOptional: [], allowPrerelease: false, allowIncompatibleVersion: false });
    expect(ModrinthPlanRequest.safeParse({ project: "luckperms", allowVersionMismatch: true }).success).toBe(false);
    expect(ModrinthPlanRequest.safeParse({ project: "../etc" }).success).toBe(false);
    expect(ModrinthPlanRequest.safeParse({ project: "..." }).success).toBe(false);
    expect(ModrinthInstallRequest.safeParse({ project: "luckperms" }).success).toBe(false);
    expect(
      ModrinthInstallRequest.safeParse({ project: "luckperms", expect: [{ projectId: "Vebnzrzj", versionId: "OrIs0S6b", action: "install" }] }).success,
    ).toBe(true);
  });

  it("search query coerces numbers and accepts comma or repeated categories", () => {
    expect(ModrinthSearchQuery.parse({ categories: "utility,economy", limit: "10" })).toMatchObject({ categories: ["utility", "economy"], limit: 10, offset: 0, sort: "relevance" });
    expect(ModrinthSearchQuery.parse({ categories: ["utility", "game-mechanics"] }).categories).toEqual(["utility", "game-mechanics"]);
    expect(ModrinthSearchQuery.safeParse({ categories: "Utility" }).success).toBe(false);
    expect(ModrinthSearchQuery.safeParse({ query: "a\u0000b" }).success).toBe(false);
    expect(ModrinthSearchQuery.safeParse({ limit: "51" }).success).toBe(false);
    expect(ModrinthSearchQuery.safeParse({ offset: "10001" }).success).toBe(false);
  });

  it("warning codes include the dependency pin codes", () => {
    for (const c of ["DEPENDENCY_PIN_IGNORED", "DEPENDENCY_PIN_CONFLICT", "NO_SHA512"]) expect(PlanWarningCode.safeParse(c).success).toBe(true);
    expect(PlanWarningCode.options).toHaveLength(23);
  });

  it("uploads, updates and installed extensions validate their bounds", () => {
    expect(ExtensionUploadRequest.safeParse({ filename: "MyPlugin.jar", sizeBytes: 1024 }).success).toBe(true);
    expect(ExtensionUploadRequest.safeParse({ filename: "MyPlugin.jar", sizeBytes: 256 * 1024 ** 2 + 1 }).success).toBe(false);
    expect(ExtensionUploadRequest.safeParse({ filename: `${"a".repeat(125)}.jar`, sizeBytes: 1 }).success).toBe(false);
    expect(ExtensionUpdatesQuery.parse({ allowPrerelease: "false" }).allowPrerelease).toBe(false);
    expect(ApplyExtensionUpdatesRequest.safeParse({ extensionIds: [WID, WID] }).success).toBe(false);
    const ext = {
      id: WID,
      serverId: WID,
      kind: "plugin",
      path: "plugins/Vault.jar.disabled",
      filename: "Vault.jar.disabled",
      enabled: false,
      sizeBytes: 47923,
      sha512: null,
      mtime: 1,
      source: "unknown",
      metadata: [],
      compatibility: null,
      modrinth: null,
      installedAt: null,
      installedBy: null,
      firstSeenAt: 1,
    };
    expect(InstalledExtension.safeParse(ext).success).toBe(true);
    expect(InstalledExtension.safeParse({ ...ext, path: "world/level.dat" }).success).toBe(false);
    expect(InstalledExtension.safeParse({ ...ext, path: "plugins/../server.jar" }).success).toBe(false);
  });
});

describe("players API", () => {
  it("player actions are strict and validate names, IPs and reasons", () => {
    expect(PlayerActionRequest.safeParse({ action: "ban", name: "Steve", reason: "griefing", expiresAt: 1_900_000_000_000 }).success).toBe(true);
    expect(PlayerActionRequest.safeParse({ action: "ban", name: "Steve", expires: 1_900_000_000_000 }).success).toBe(false);
    expect(PlayerActionRequest.safeParse({ action: "kick", name: "@a" }).success).toBe(false);
    expect(PlayerActionRequest.safeParse({ action: "kick", name: "Steve", reason: "bye\nop Steve" }).success).toBe(false);
    expect(PlayerActionRequest.safeParse({ action: "kick", name: "Steve", reason: "x".repeat(201) }).success).toBe(false);
    expect(PlayerActionRequest.safeParse({ action: "op", name: "Steve", level: 5 }).success).toBe(false);
    expect(PlayerActionRequest.safeParse({ action: "whitelist-reload" }).success).toBe(true);
    expect(PlayerActionRequest.safeParse({ action: "sudo", name: "Steve" }).success).toBe(false);
  });

  it.each(["203.0.113.7", "0.0.0.0", "255.255.255.255"])("BanIpAddress accepts %s", (ip) => {
    expect(BanIpAddress.safeParse(ip).success).toBe(true);
  });
  it.each(["010.0.0.1", "256.1.1.1", "::1", "2001:db8::1", "::ffff:203.0.113.7", "203.0.113.7:25565", "10.0.0.0/8", " 1.2.3.4"])(
    "BanIpAddress rejects %s",
    (ip) => {
      expect(BanIpAddress.safeParse(ip).success).toBe(false);
    },
  );

  it("player UUIDs are dashed lowercase of any version", () => {
    expect(PlayerUuid.safeParse("069a79f4-44e9-4726-a5be-fca90e38aaf5").success).toBe(true);
    expect(PlayerUuid.safeParse("4566e69f-c907-38ee-8d71-d7e1e6d3a2bf").success).toBe(true);
    expect(PlayerUuid.safeParse("069a79f444e94726a5befca90e38aaf5").success).toBe(false);
    expect(PlayerUuid.safeParse("069A79F4-44E9-4726-A5BE-FCA90E38AAF5").success).toBe(false);
  });
});

describe("realtime and errors", () => {
  it("new server-topic events have payload schemas", () => {
    expect(REALTIME_EVENT_PAYLOADS["player.joined"].safeParse({ serverId: WID, name: "Steve", uuid: null, at: 1, sessionId: null }).success).toBe(true);
    expect(REALTIME_EVENT_PAYLOADS["player.left"].safeParse({ serverId: WID, name: "Steve", uuid: null, at: 1, sessionId: WID, reason: "Disconnected" }).success).toBe(true);
    expect(
      REALTIME_EVENT_PAYLOADS["extensions.updated"].safeParse({
        serverId: WID,
        scan: { status: "completed", scannedAt: 1, jobId: null, error: null },
        changed: null,
      }).success,
    ).toBe(true);
  });
  it("RATE_LIMITED details carry retryAfterMs and the upstream", () => {
    expect(RateLimitedErrorDetails.safeParse({ retryAfterMs: 1500, upstream: "modrinth" }).success).toBe(true);
    expect(RateLimitedErrorDetails.safeParse({ retryAfterSeconds: 2 }).success).toBe(false);
  });
});
