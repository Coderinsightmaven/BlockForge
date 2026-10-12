import { describe, expect, it } from "vitest";
import {
  PLATFORM_MANAGED_PROPERTY_KEYS,
  PROPERTY_SCHEMA,
  SECRET_PROPERTY_KEYS,
  gameRuleId,
  gameplayToProperties,
  getProperties,
  parseProperties,
  platformProperties,
  redactServerProperties,
  validateProperties,
} from "../src/index.js";
import { fixture } from "./helpers.js";

const codes = (r: { issues: Array<{ key: string; code: string }> }, key?: string) => r.issues.filter((i) => key === undefined || i.key === key).map((i) => i.code);

describe("property schema", () => {
  it("covers every key written by the real 26.3, 1.21.8 and 1.20.3 servers", () => {
    for (const f of ["vanilla-26.3", "vanilla-1.21.8", "vanilla-1.20.3"]) {
      const keys = Object.keys(getProperties(parseProperties(fixture(`properties/${f}.server.properties`))));
      expect(keys.filter((k) => !PROPERTY_SCHEMA.has(k))).toEqual([]);
    }
  });

  it("flags secrets and platform-managed keys", () => {
    expect(SECRET_PROPERTY_KEYS).toEqual(expect.arrayContaining(["rcon.password", "management-server-secret", "management-server-tls-keystore-password"]));
    expect(PLATFORM_MANAGED_PROPERTY_KEYS).toEqual(expect.arrayContaining(["server-port", "rcon.port", "enable-query", "query.port"]));
  });

  it("validates the real default files without errors", () => {
    const managed = { flagPlatformManaged: false };
    expect(validateProperties(getProperties(parseProperties(fixture("properties/vanilla-26.3.server.properties"))), "26.3", managed).ok).toBe(true);
    const r = validateProperties(getProperties(parseProperties(fixture("properties/vanilla-1.21.8.server.properties"))), "1.21.8", managed);
    expect(r.issues.filter((i) => i.severity !== "info")).toEqual([]);
  });
});

describe("validateProperties", () => {
  it("checks types, enums and ranges", () => {
    const r = validateProperties(
      { "online-mode": "yes", "max-players": "20.5", "op-permission-level": "7", difficulty: "insane", gamemode: "1", "view-distance": "48", "server-port": "25565" },
      "26.3",
    );
    expect(r.ok).toBe(false);
    expect(codes(r, "online-mode")).toContain("INVALID_BOOLEAN");
    expect(codes(r, "max-players")).toContain("INVALID_INTEGER");
    expect(codes(r, "op-permission-level")).toContain("OUT_OF_RANGE");
    expect(codes(r, "difficulty")).toContain("INVALID_ENUM");
    expect(codes(r, "gamemode")).toEqual(["LEGACY_NUMERIC"]);
    expect(r.issues.find((i) => i.key === "view-distance")?.severity).toBe("warning");
    expect(codes(r, "server-port")).toEqual(["PLATFORM_MANAGED"]);
  });

  it("knows version-specific keys (1.21.9 game-rule move, 1.18 simulation-distance)", () => {
    expect(codes(validateProperties({ pvp: "false" }, "26.3"), "pvp")).toEqual(["REMOVED_IN_VERSION"]);
    expect(validateProperties({ pvp: "false" }, "26.3").issues[0]!.message).toMatch(/game rule pvp/);
    expect(codes(validateProperties({ pvp: "false" }, "1.21.8"), "pvp")).toEqual([]);
    expect(codes(validateProperties({ "simulation-distance": "8" }, "1.17.1"), "simulation-distance")).toEqual(["NOT_IN_VERSION"]);
    expect(codes(validateProperties({ "accepts-transfers": "true" }, "1.20.5"))).toEqual([]);
    expect(codes(validateProperties({ "some-mod-key": "x" }, "26.3"))).toEqual(["UNKNOWN_KEY"]);
    expect(codes(validateProperties({ motd: "x" }, "25w14a"))).toEqual(["VERSION_UNORDERED"]);
    expect(codes(validateProperties({ motd: "x" }, "1.12.2"))).toEqual(["SCHEMA_UNVERIFIED"]);
  });

  it("checks resource pack, level and cross-field rules", () => {
    const r = validateProperties(
      {
        "resource-pack": "ftp://x",
        "resource-pack-sha1": "xyz",
        "resource-pack-id": "nope",
        "level-name": "../escape",
        "level-type": "minecraft:custom_thing",
        "level-seed": "hello",
        "view-distance": "6",
        "simulation-distance": "10",
        "enforce-whitelist": "true",
        "white-list": "false",
        "require-resource-pack": "true",
        "online-mode": "false",
        "enable-rcon": "true",
      },
      "26.3",
      { flagPlatformManaged: false },
    );
    expect(codes(r)).toEqual(
      expect.arrayContaining([
        "INVALID_URL",
        "INVALID_SHA1",
        "INVALID_UUID",
        "INVALID_LEVEL_NAME",
        "LEVEL_TYPE",
        "SEED_INFO",
        "SIMULATION_EXCEEDS_VIEW",
        "ENFORCE_WITHOUT_WHITELIST",
        "OFFLINE_MODE",
        "RCON_WITHOUT_PASSWORD",
      ]),
    );
    expect(codes(validateProperties({ "online-mode": "false" }, "26.3", { behindProxy: true }))).toEqual([]);
  });
});

describe("gameplay mapping", () => {
  const settings = { motd: "Hi", maxPlayers: 40, difficulty: "hard", gamemode: "creative", whitelist: true, pvp: false, allowNether: false, enableCommandBlock: true, simulationDistance: 8 } as const;

  it("writes pvp/allow-nether/enable-command-block as properties before 1.21.9", () => {
    const m = gameplayToProperties(settings, "1.21.8");
    expect(m.properties).toMatchObject({ pvp: "false", "allow-nether": "false", "enable-command-block": "true", "white-list": "true", "enforce-whitelist": "true", difficulty: "hard" });
    expect(m.gameRules).toEqual([]);
  });

  it("uses camelCase game rules on 1.21.9–1.21.10", () => {
    const m = gameplayToProperties(settings, "1.21.10");
    expect(m.properties).not.toHaveProperty("pvp");
    expect(m.gameRules).toEqual([
      { rule: "pvp", value: "false", command: "gamerule pvp false" },
      { rule: "commandBlocksEnabled", value: "true", command: "gamerule commandBlocksEnabled true" },
      { rule: "allowEnteringNetherUsingPortals", value: "false", command: "gamerule allowEnteringNetherUsingPortals false" },
    ]);
  });

  it("uses namespaced snake_case game rules on 1.21.11+ and 26.x", () => {
    const m = gameplayToProperties(settings, "26.3");
    expect(m.gameRules.map((g) => g.rule)).toEqual(["minecraft:pvp", "minecraft:command_blocks_work", "minecraft:allow_entering_nether_using_portals"]);
    expect(gameRuleId("allowNether", "1.21.11")).toBe("minecraft:allow_entering_nether_using_portals");
    expect(m.warnings.join(" ")).toMatch(/game rules/);
  });

  it("uses numeric difficulty/gamemode before 1.14 and skips unknown keys for old versions", () => {
    const m = gameplayToProperties({ ...settings, requireResourcePack: true }, "1.12.2");
    expect(m.properties).toMatchObject({ difficulty: "3", gamemode: "1" });
    expect(m.properties).not.toHaveProperty("simulation-distance");
    expect(m.properties).not.toHaveProperty("require-resource-pack");
    expect(m.warnings.length).toBeGreaterThanOrEqual(2);
  });

  it("normalises level types", () => {
    expect(gameplayToProperties({ levelType: "default" }, "26.3").properties["level-type"]).toBe("minecraft:normal");
    expect(gameplayToProperties({ levelType: "flat" }, "1.20.4").properties["level-type"]).toBe("minecraft:flat");
  });

  it("produces platform-managed keys", () => {
    expect(platformProperties({ minecraftVersion: "26.3", rcon: { enabled: true, port: 25575, password: "pw" } })).toEqual({
      "server-ip": "",
      "server-port": "25565",
      "enable-query": "false",
      "enable-rcon": "true",
      "rcon.port": "25575",
      "rcon.password": "pw",
      "management-server-enabled": "false",
    });
    expect(platformProperties({ minecraftVersion: "1.20.4" })).not.toHaveProperty("management-server-enabled");
  });
});

describe("redaction", () => {
  it("masks every secret occurrence and keeps layout", () => {
    const text = fixture("properties/vanilla-26.3.server.properties").replace("rcon.password=", "rcon.password=s3cr3t-rcon") + "rcon.password=s3cr3t-dup\n";
    const out = redactServerProperties(text);
    expect(out).not.toContain("s3cr3t");
    expect(out).not.toContain("FIXTUREFIXTURE");
    expect(out).toContain("management-server-secret=**redacted**");
    expect(out.split("\n")).toHaveLength(text.split("\n").length);
    expect(redactServerProperties("motd=hi\n")).toBe("motd=hi\n");
  });
});
