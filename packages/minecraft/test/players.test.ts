import { createHash, randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  CatalogError,
  PlayerInputError,
  addToWhitelist,
  banIp,
  banPlayer,
  emptyPlayerList,
  formatBanDate,
  isBanActive,
  isValidPlayerName,
  lookupMojangProfile,
  md5,
  nameUuidFromBytes,
  normalizeIp,
  normalizeUuid,
  offlinePlayerUuid,
  parseBanDate,
  parseCommandFeedback,
  parsePlayerList,
  parsePlayerListOutput,
  parseVelocityGlist,
  playerCommands,
  removeFromPlayerList,
  resolvePlayerProfile,
  sanitizeReason,
  serializePlayerList,
  setOperator,
  supportedPlayerCommands,
  uuidVersion,
  type PlayerListKind,
} from "../src/index.js";
import { ctxFor, fixture } from "./helpers.js";

const NOTCH = "069a79f4-44e9-4726-a5be-fca90e38aaf5";
const JEB = "853c80ef-3c37-49fd-aa49-938b674adae6";

describe("UUIDs and names", () => {
  it("offline-mode UUIDs match Java's UUID.nameUUIDFromBytes (values printed by JDK 17)", () => {
    const java: Array<[string, string]> = [
      ["Notch", "b50ad385-829d-3141-a216-7e7d7539ba7f"],
      ["notch", "42653081-a90e-3475-b3d6-3550cdb43f8e"],
      ["Griefer", "fc55e503-efd6-3331-a6df-f7f5e1ebbd4b"],
      ["a", "52428a0e-1e30-3cb1-976c-e728b2614047"],
      ["_", "49cdfde1-69b5-3f8c-abc6-4d441e451d56"],
      ["ABCDEFGHIJKLMNOP", "2b74a1cc-0832-35db-8638-abf7e029466d"],
      ["ÄÖÜ", "4d6596c7-860c-33f7-9205-74f7257bb0cc"],
    ];
    for (const [name, uuid] of java) expect(offlinePlayerUuid(name)).toBe(uuid);
    expect(uuidVersion(offlinePlayerUuid("Notch"))).toBe(3);
    expect(uuidVersion(NOTCH)).toBe(4);
  });

  it("MD5 matches node:crypto (RFC 1321 vectors and random inputs across block boundaries)", () => {
    const hex = (b: Uint8Array) => Buffer.from(b).toString("hex");
    expect(hex(md5(new Uint8Array()))).toBe("d41d8cd98f00b204e9800998ecf8427e");
    expect(hex(md5(new TextEncoder().encode("abc")))).toBe("900150983cd24fb0d6963f7d28e17f72");
    for (const len of [1, 55, 56, 63, 64, 65, 119, 120, 1000]) {
      const data = randomBytes(len);
      expect(hex(md5(new Uint8Array(data)))).toBe(createHash("md5").update(data).digest("hex"));
    }
    expect(nameUuidFromBytes(new TextEncoder().encode("OfflinePlayer:Notch"))).toBe("b50ad385-829d-3141-a216-7e7d7539ba7f");
  });

  it("normalises UUIDs and validates names", () => {
    expect(normalizeUuid("069A79F444E94726A5BEFCA90E38AAF5")).toBe(NOTCH);
    expect(normalizeUuid(` ${NOTCH} `)).toBe(NOTCH);
    for (const bad of ["", "069a79f4", `${NOTCH}0`, "zz9a79f4-44e9-4726-a5be-fca90e38aaf5", "069a79f4-44e94726-a5be-fca90e38aaf5"]) expect(normalizeUuid(bad)).toBeNull();
    for (const ok of ["Notch", "jeb_", "a", "ABCDEFGHIJKLMNOP"]) expect(isValidPlayerName(ok)).toBe(true);
    for (const bad of ["", "ABCDEFGHIJKLMNOPQ", "a b", "@a", "@p", "a\nstop", "Ünïcode", ".Bedrock", "a;b", "a-b"]) expect(isValidPlayerName(bad)).toBe(false);
  });
});

describe("player list files (byte-exact against Gson output)", () => {
  const files: Array<[PlayerListKind, string]> = [
    ["whitelist", "gson-whitelist.json"],
    ["ops", "gson-ops.json"],
    ["banned-players", "gson-banned-players.json"],
    ["banned-ips", "gson-banned-ips.json"],
    ["whitelist", "gson-empty.json"],
  ];

  it.each(files)("%s: %s parses and round-trips byte-for-byte", (kind, file) => {
    const text = fixture(`players/${file}`);
    const doc = parsePlayerList(kind, text);
    expect(doc.issues).toEqual([]);
    expect(serializePlayerList(doc)).toBe(text);
  });

  it("parses typed entries", () => {
    expect(parsePlayerList("whitelist", fixture("players/gson-whitelist.json")).entries).toEqual([
      { uuid: NOTCH, name: "Notch" },
      { uuid: JEB, name: "jeb_" },
    ]);
    expect(parsePlayerList("ops", fixture("players/gson-ops.json")).entries[1]).toEqual({ uuid: JEB, name: "jeb_", level: 2, bypassesPlayerLimit: true });
    const bans = parsePlayerList("banned-players", fixture("players/gson-banned-players.json")).entries;
    expect(bans[0]).toEqual({
      uuid: offlinePlayerUuid("Griefer"),
      name: "Griefer",
      created: "2026-10-12 19:30:00 +0000",
      source: "Server",
      expires: "forever",
      reason: "Don't grief <spawn> & \"town\" = bad",
    });
    expect(bans[1]!.reason).toBe("Spam ☃ line\u2028sep \\ back");
    expect(parsePlayerList("banned-ips", fixture("players/gson-banned-ips.json")).entries[0]!.ip).toBe("203.0.113.7");
    expect(parsePlayerList("ops", "").entries).toEqual([]);
  });

  it("builds files identical to the server's from scratch", () => {
    let wl = emptyPlayerList("whitelist");
    wl = addToWhitelist(wl, { uuid: NOTCH.replace(/-/g, ""), name: "Notch" });
    wl = addToWhitelist(wl, { uuid: JEB, name: "jeb_" });
    expect(serializePlayerList(wl)).toBe(fixture("players/gson-whitelist.json"));

    let ops = emptyPlayerList("ops");
    ops = setOperator(ops, { uuid: NOTCH, name: "Notch" });
    ops = setOperator(ops, { uuid: JEB, name: "jeb_", level: 2, bypassesPlayerLimit: true });
    expect(serializePlayerList(ops)).toBe(fixture("players/gson-ops.json"));

    const now = new Date("2026-10-12T19:30:00Z");
    const ips = banIp(emptyPlayerList("banned-ips"), { ip: "203.0.113.7", reason: "Banned by an operator.", now });
    expect(serializePlayerList(ips)).toBe(fixture("players/gson-banned-ips.json"));

    const bans = banPlayer(emptyPlayerList("banned-players"), { uuid: offlinePlayerUuid("Griefer"), name: "Griefer", source: "Server", reason: "Don't grief <spawn> & \"town\" = bad", now });
    const expected = JSON.parse(fixture("players/gson-banned-players.json")) as unknown[];
    expect(serializePlayerList(bans)).toBe(serializePlayerList({ raw: expected.slice(0, 1) }));
  });

  it("updates in place, keeps unknown keys, key order and entries it cannot validate", () => {
    const text = JSON.stringify([
      { name: "OldName", uuid: NOTCH, comment: "added by hand" },
      { uuid: "not-a-uuid", name: "Broken" },
      "garbage",
    ]);
    const doc = parsePlayerList("whitelist", text);
    expect(doc.entries).toHaveLength(1);
    expect(doc.issues).toEqual(["entry 2: invalid or missing uuid (the server ignores it; kept unchanged)", "entry 3: not an object (kept unchanged)"]);
    const updated = addToWhitelist(doc, { uuid: NOTCH, name: "Notch" });
    expect(JSON.parse(serializePlayerList(updated))).toEqual([{ name: "Notch", uuid: NOTCH, comment: "added by hand" }, { uuid: "not-a-uuid", name: "Broken" }, "garbage"]);
    expect(Object.keys((JSON.parse(serializePlayerList(updated)) as Array<Record<string, unknown>>)[0]!)).toEqual(["name", "uuid", "comment"]);

    const ops = setOperator(parsePlayerList("ops", fixture("players/gson-ops.json")), { uuid: JEB, name: "jeb_", level: 3 });
    expect(ops.entries.map((e) => `${e.name}:${e.level}:${e.bypassesPlayerLimit}`)).toEqual(["Notch:4:false", "jeb_:3:false"]);
  });

  it("is safe against __proto__ keys", () => {
    const doc = parsePlayerList("whitelist", `[{"uuid":"${NOTCH}","name":"Notch","__proto__":{"polluted":true}}]`);
    const updated = addToWhitelist(doc, { uuid: NOTCH, name: "Notch" });
    expect(({} as Record<string, unknown>)["polluted"]).toBeUndefined();
    expect(serializePlayerList(updated)).toContain('"__proto__"');
  });

  it("removes by name (case-insensitive), UUID (any form) or IP", () => {
    const wl = parsePlayerList("whitelist", fixture("players/gson-whitelist.json"));
    expect(removeFromPlayerList(wl, "NOTCH").removed).toBe(1);
    expect(removeFromPlayerList(wl, JEB.replace(/-/g, "").toUpperCase()).doc.entries.map((e) => e.name)).toEqual(["Notch"]);
    expect(removeFromPlayerList(wl, "nobody").removed).toBe(0);
    expect(removeFromPlayerList(wl, "").removed).toBe(0);
    const ips = parsePlayerList("banned-ips", fixture("players/gson-banned-ips.json"));
    expect(removeFromPlayerList(ips, "203.0.113.7").doc.entries).toEqual([]);
  });

  it("validates writes", () => {
    const now = new Date("2026-10-12T19:30:00Z");
    expect(() => addToWhitelist(emptyPlayerList("whitelist"), { uuid: "x", name: "Notch" })).toThrow(PlayerInputError);
    expect(() => addToWhitelist(emptyPlayerList("whitelist"), { uuid: NOTCH, name: "@a" })).toThrow(PlayerInputError);
    expect(() => setOperator(emptyPlayerList("ops"), { uuid: NOTCH, name: "Notch", level: 5 })).toThrow(PlayerInputError);
    expect(() => setOperator(emptyPlayerList("ops"), { uuid: NOTCH, name: "Notch", level: 0 })).toThrow(PlayerInputError);
    expect(() => banPlayer(emptyPlayerList("banned-players"), { uuid: NOTCH, name: "Notch", reason: "line\nbreak", now })).toThrow(PlayerInputError);
    expect(() => banPlayer(emptyPlayerList("banned-players"), { uuid: NOTCH, name: "Notch", source: "x".repeat(300), now })).toThrow(PlayerInputError);
    expect(() => banPlayer(emptyPlayerList("banned-players"), { uuid: NOTCH, name: "Notch", expires: new Date("2026-01-01T00:00:00Z"), now })).toThrow(/expired/);
    expect(() => banIp(emptyPlayerList("banned-ips"), { ip: "10.0.0.256", now })).toThrow(PlayerInputError);
    const temp = banPlayer(emptyPlayerList("banned-players"), { uuid: NOTCH, name: "Notch", expires: new Date("2026-10-19T19:30:00Z"), now });
    expect(temp.entries[0]).toMatchObject({ expires: "2026-10-19 19:30:00 +0000", source: "(Unknown)", reason: null });
    expect(Object.keys(temp.raw[0] as object)).toEqual(["uuid", "name", "created", "source", "expires"]);
  });

  it("ban dates and expiry", () => {
    expect(parseBanDate("2026-10-12 21:30:00 +0200")!.toISOString()).toBe("2026-10-12T19:30:00.000Z");
    expect(parseBanDate("2026-10-12 14:30:00 -0500")!.toISOString()).toBe("2026-10-12T19:30:00.000Z");
    expect(parseBanDate("forever")).toBeNull();
    expect(formatBanDate(new Date("2026-01-02T03:04:05Z"))).toBe("2026-01-02 03:04:05 +0000");
    const now = new Date("2026-10-15T00:00:00Z");
    expect(isBanActive({ expires: "forever" }, now)).toBe(true);
    expect(isBanActive({ expires: "2026-10-19 19:30:00 +0000" }, now)).toBe(true);
    expect(isBanActive({ expires: "2026-10-12 19:30:00 +0000" }, now)).toBe(false);
  });

  it("IP addresses", () => {
    expect(normalizeIp("203.0.113.7")).toBe("203.0.113.7");
    // IPv4-mapped IPv6 → the dotted form the server keys bans by; other IPv6 never matches a vanilla ban.
    expect(normalizeIp("::ffff:127.0.0.1")).toBe("127.0.0.1");
    expect(normalizeIp("::FFFF:7f00:1")).toBe("127.0.0.1");
    expect(normalizeIp("2001:DB8:0:0::1")).toBeNull();
    expect(normalizeIp("::1")).toBeNull();
    for (const bad of ["", "1.2.3", "1.2.3.4:25565", "01.2.3.4", "[::1]", "::1%eth0", "10.0.0.0/8", "example.com", "1.2.3.4 ; stop"]) expect(normalizeIp(bad)).toBeNull();
  });

  it("rejects non-array documents", () => {
    expect(() => parsePlayerList("ops", "{}")).toThrow(PlayerInputError);
    expect(() => parsePlayerList("ops", "[")).toThrow(PlayerInputError);
  });
});

describe("console commands", () => {
  it("builds validated commands", () => {
    expect(playerCommands.whitelistAdd("Notch")).toBe("whitelist add Notch");
    expect(playerCommands.whitelistRemove("jeb_")).toBe("whitelist remove jeb_");
    expect(playerCommands.op("Notch")).toBe("op Notch");
    expect(playerCommands.deop("Notch")).toBe("deop Notch");
    expect(playerCommands.ban("Griefer", "Griefing at spawn")).toBe("ban Griefer Griefing at spawn");
    expect(playerCommands.ban("Griefer")).toBe("ban Griefer");
    expect(playerCommands.pardon("Griefer")).toBe("pardon Griefer");
    expect(playerCommands.banIp({ ip: "203.0.113.7" }, "VPN abuse")).toBe("ban-ip 203.0.113.7 VPN abuse");
    expect(playerCommands.banIp({ name: "Griefer" })).toBe("ban-ip Griefer");
    expect(playerCommands.pardonIp("::ffff:203.0.113.7")).toBe("pardon-ip 203.0.113.7");
    expect(() => playerCommands.pardonIp("2001:db8::1")).toThrow(PlayerInputError);
    expect(playerCommands.kick("Notch", "Restarting")).toBe("kick Notch Restarting");
    expect(playerCommands.list({ uuids: true })).toBe("list uuids");
    expect(playerCommands.whitelistReload()).toBe("whitelist reload");
  });

  it("never lets input add a second command or a selector", () => {
    for (const name of ["Notch\nstop", "Notch\rstop", "@a", "@e[type=player]", "Notch stop", "", "Notch\u2028stop"]) {
      expect(() => playerCommands.kick(name)).toThrow(PlayerInputError);
      expect(() => playerCommands.op(name)).toThrow(PlayerInputError);
    }
    expect(() => playerCommands.pardonIp("1.2.3.4\nstop")).toThrow(PlayerInputError);
    expect(playerCommands.kick("Notch", "bye\nstop\r\nop Griefer")).toBe("kick Notch bye stop op Griefer");
    expect(playerCommands.ban("Notch", "a\u202Eb\u2028c\u0000d\u0085e")).toBe("ban Notch a b c d e");
    expect(playerCommands.kick("Notch", "   \n\t ")).toBe("kick Notch");
    expect(sanitizeReason("x".repeat(500))).toHaveLength(200);
    expect(sanitizeReason("\u{1F600}".repeat(300))).toBe("\u{1F600}".repeat(200));
  });

  it("supported commands per software", () => {
    expect(supportedPlayerCommands("velocity")).toEqual(["glistAll"]);
    expect(supportedPlayerCommands("paper")).toContain("banIp");
    expect(supportedPlayerCommands("paper")).not.toContain("glistAll");
  });
});

describe("command output parsing (format strings from the 26.3 / 1.12.2 jars and Velocity 4.2.0)", () => {
  const lang = JSON.parse(fixture("players/lang-26.3-en_us-commands.json")) as Record<string, string>;
  const legacy = Object.fromEntries(
    fixture("players/lang-1.12.2-en_us-commands.lang")
      .split(/\r?\n/)
      .filter((l) => l.includes("="))
      .map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1)]),
  ) as Record<string, string>;
  const velocity = Object.fromEntries(
    fixture("players/velocity-4.2.0-messages-glist.properties")
      .split(/\r?\n/)
      .filter((l) => l.includes("="))
      .map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1)]),
  ) as Record<string, string>;
  const fmt = (template: string, ...args: string[]) => {
    let i = 0;
    return template.replace(/%s/g, () => args[i++] ?? "");
  };
  const mm = (template: string, ...args: string[]) => template.replace(/<arg:(\d+)>/g, (_m, n: string) => args[Number(n)] ?? "");

  it("vanilla/Paper `list` and `list uuids` (with log prefixes)", () => {
    const names = `Notch, jeb_`;
    const paper = parsePlayerListOutput([`[19:30:01 INFO]: ${fmt(lang["commands.list.players"]!, "2", "20", names)}`]);
    expect(paper).toEqual({ format: "vanilla", online: 2, max: 20, players: [{ name: "Notch", uuid: null }, { name: "jeb_", uuid: null }], skipped: 0 });
    const withIds = [fmt(lang["commands.list.nameAndId"]!, "Notch", NOTCH), fmt(lang["commands.list.nameAndId"]!, "jeb_", JEB)].join(", ");
    const vanilla = parsePlayerListOutput([`[19:30:01] [Server thread/INFO]: ${fmt(lang["commands.list.players"]!, "2", "20", withIds)}`]);
    expect(vanilla!.players).toEqual([{ name: "Notch", uuid: NOTCH }, { name: "jeb_", uuid: JEB }]);
    expect(parsePlayerListOutput([`[19:30:01 INFO]: ${fmt(lang["commands.list.players"]!, "0", "20", "")}`])).toEqual({ format: "vanilla", online: 0, max: 20, players: [], skipped: 0 });
  });

  it("legacy (≤ 1.12) two-line `list` output", () => {
    const head = fmt(legacy["commands.players.list"]!, "2", "20");
    expect(head).toBe("There are 2/20 players online:");
    expect(parsePlayerListOutput([`[19:30:01] [Server thread/INFO]: ${head}`, "[19:30:01] [Server thread/INFO]: Notch, jeb_"])).toEqual({
      format: "legacy",
      online: 2,
      max: 20,
      players: [{ name: "Notch", uuid: null }, { name: "jeb_", uuid: null }],
      skipped: 0,
    });
    expect(parsePlayerListOutput([`[19:30:01] [Server thread/INFO]: ${fmt(legacy["commands.players.list"]!, "0", "20")}`])!.players).toEqual([]);
  });

  it("ignores chat lines that imitate the output", () => {
    expect(parsePlayerListOutput([`[19:30:01 INFO]: <Griefer> ${fmt(lang["commands.list.players"]!, "1", "20", "Admin")}`])).toBeNull();
    expect(parsePlayerListOutput(["[19:30:01 INFO]: Done (3.2s)! For help, type \"help\""])).toBeNull();
  });

  it("Velocity `glist all`", () => {
    const lines = [
      `[19:30:01 INFO]: [lobby] (2): Notch, jeb_`,
      `[19:30:01 INFO]: [survival] (1): Griefer`,
      `[19:30:01 INFO]: ${mm(velocity["velocity.command.glist-player-plural"]!, "3")}`,
    ];
    expect(parseVelocityGlist(lines)).toEqual({
      format: "velocity",
      total: 3,
      servers: [
        { server: "lobby", count: 2, players: ["Notch", "jeb_"], skipped: 0 },
        { server: "survival", count: 1, players: ["Griefer"], skipped: 0 },
      ],
    });
    const t = "[19:30:01 INFO]: ";
    expect(parseVelocityGlist([t + mm(velocity["velocity.command.glist-player-singular"]!, "1"), t + velocity["velocity.command.glist-view-all"]!])).toEqual({ format: "velocity", total: 1, servers: [] });
    // Bare text or another logger is not Velocity's output.
    expect(parseVelocityGlist([mm(velocity["velocity.command.glist-player-singular"]!, "1")])).toBeNull();
    expect(parseVelocityGlist(["[19:30:01 INFO] [com.evil.Plugin]: [lobby] (1): Notch"])).toBeNull();
    expect(parseVelocityGlist(["[19:30:01 INFO]: nothing"])).toBeNull();
  });

  it("command feedback (26.3 and 1.12.2 strings)", () => {
    const cases: Array<[string, Record<string, unknown>]> = [
      [fmt(lang["commands.whitelist.add.success"]!, "Notch"), { action: "whitelist.add", ok: true, target: "Notch" }],
      [lang["commands.whitelist.add.failed"]!, { action: "whitelist.add", ok: false }],
      [fmt(lang["commands.whitelist.remove.success"]!, "Notch"), { action: "whitelist.remove", ok: true }],
      [fmt(lang["commands.op.success"]!, "Notch"), { action: "op", ok: true, target: "Notch" }],
      [lang["commands.op.failed"]!, { action: "op", ok: false }],
      [fmt(lang["commands.deop.success"]!, "Notch"), { action: "deop", ok: true, target: "Notch" }],
      [fmt(lang["commands.ban.success"]!, "Griefer", "Banned by an operator."), { action: "ban", ok: true, target: "Griefer", reason: "Banned by an operator." }],
      [lang["commands.ban.failed"]!, { action: "ban", ok: false }],
      [fmt(lang["commands.pardon.success"]!, "Griefer"), { action: "pardon", ok: true, target: "Griefer" }],
      [fmt(lang["commands.banip.success"]!, "203.0.113.7", "VPN"), { action: "ban-ip", ok: true, target: "203.0.113.7", reason: "VPN" }],
      [lang["commands.banip.invalid"]!, { action: "ban-ip", ok: false }],
      [fmt(lang["commands.pardonip.success"]!, "203.0.113.7"), { action: "pardon-ip", ok: true, target: "203.0.113.7" }],
      [fmt(lang["commands.kick.success"]!, "Notch", "Restarting"), { action: "kick", ok: true, target: "Notch", reason: "Restarting" }],
      [lang["argument.player.unknown"]!, { action: "player", ok: false }],
      [fmt(legacy["commands.op.success"]!, "Notch"), { action: "op", ok: true, target: "Notch" }],
      [fmt(legacy["commands.deop.success"]!, "Notch"), { action: "deop", ok: true }],
      [fmt(legacy["commands.ban.success"]!, "Griefer"), { action: "ban", ok: true, target: "Griefer" }],
      [fmt(legacy["commands.unban.success"]!, "Griefer"), { action: "pardon", ok: true, target: "Griefer" }],
      [fmt(legacy["commands.banip.success"]!, "203.0.113.7"), { action: "ban-ip", ok: true, target: "203.0.113.7" }],
      [fmt(legacy["commands.unbanip.success"]!, "203.0.113.7"), { action: "pardon-ip", ok: true }],
      [fmt(legacy["commands.kick.success.reason"]!, "Notch", "bye"), { action: "kick", ok: true, target: "Notch", reason: "bye" }],
      [fmt(legacy["commands.kick.success"]!, "Notch"), { action: "kick", ok: true, reason: null }],
      [fmt(legacy["commands.whitelist.add.failed"]!, "Notch"), { action: "whitelist.add", ok: false }],
    ];
    for (const [msg, expected] of cases) expect(parseCommandFeedback(`[19:30:01 INFO]: ${msg}`), msg).toMatchObject(expected);
    expect(parseCommandFeedback("[19:30:01 INFO]: <Griefer> Made Griefer a server operator")).toBeNull();
  });
});

describe("Mojang profile lookup (recorded 2026-10-12)", () => {
  const base = "https://api.mojang.com/users/profiles/minecraft/";

  it("resolves names case-insensitively to dashed UUIDs; unknown → null", async () => {
    const ctx = ctxFor({
      [`${base}Notch`]: fixture("players/mojang-profile-Notch.json"),
      [`${base}notch`]: fixture("players/mojang-profile-notch-lowercase.json"),
      [`${base}bf_nx_q9z2k7w1`]: { status: 404, body: fixture("players/mojang-profile-404.json") },
    });
    expect(await lookupMojangProfile(ctx, "Notch")).toEqual({ uuid: NOTCH, name: "Notch", source: "mojang" });
    expect(await lookupMojangProfile(ctx, "notch")).toEqual({ uuid: NOTCH, name: "Notch", source: "mojang" });
    expect(await lookupMojangProfile(ctx, "bf_nx_q9z2k7w1")).toBeNull();
    expect(ctx.misses).toEqual([]);
  });

  it("validates names before any request, maps 429, and stays on api.mojang.com", async () => {
    const ctx = ctxFor({ [`${base}Busy`]: { status: 429 } });
    await expect(lookupMojangProfile(ctx, "../../x")).rejects.toBeInstanceOf(PlayerInputError);
    await expect(lookupMojangProfile(ctx, "a b")).rejects.toBeInstanceOf(PlayerInputError);
    expect(ctx.calls).toEqual([]);
    await expect(lookupMojangProfile(ctx, "Busy")).rejects.toMatchObject({ code: "RATE_LIMITED", retryAfterMs: 60_000 });
    const redirect = {
      fetch: async () => new Response(null, { status: 302, headers: { location: "https://169.254.169.254/latest" } }),
    };
    await expect(lookupMojangProfile(redirect, "Notch")).rejects.toBeInstanceOf(CatalogError);
    const evil = ctxFor({ [`${base}Notch`]: '{"id":"../../etc","name":"Notch"}' });
    await expect(lookupMojangProfile(evil, "Notch")).rejects.toMatchObject({ code: "INVALID_UPSTREAM_RESPONSE" });
  });

  it("offline mode uses the name UUID without network", async () => {
    const ctx = ctxFor({});
    expect(await resolvePlayerProfile(ctx, "Notch", { onlineMode: false })).toEqual({ uuid: "b50ad385-829d-3141-a216-7e7d7539ba7f", name: "Notch", source: "offline" });
    expect(ctx.calls).toEqual([]);
  });
});
