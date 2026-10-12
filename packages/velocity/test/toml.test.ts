import { describe, expect, it } from "vitest";
import { parse } from "smol-toml";
import { TomlDocument, TomlEditError, TomlSyntaxError, formatString } from "../src/index.js";
import { DEFAULT_TOML, changedLines, commentLines } from "./helpers.js";

describe("TomlDocument on the real Velocity 4.2.0 default config", () => {
  it("round-trips byte-for-byte without edits", () => {
    const text = DEFAULT_TOML();
    expect(TomlDocument.parse(text).toString()).toBe(text);
  });

  it("reads values through smol-toml", () => {
    const doc = TomlDocument.parse(DEFAULT_TOML());
    expect(doc.get("", "config-version")).toBe("2.9");
    expect(doc.get("", "bind")).toBe("0.0.0.0:25565");
    expect(doc.get("servers", "try")).toEqual(["lobby"]);
    expect(doc.get("forced-hosts", "lobby.example.com")).toEqual(["lobby"]);
    expect(doc.get("advanced", "compression-threshold")).toBe(256);
    expect(doc.get("ping-passthrough", "favicon")).toBe(false);
    expect(doc.keys("servers")).toEqual([["lobby"], ["factions"], ["minigames"], ["try"]]);
    expect(doc.keys("forced-hosts").map((k) => k[0])).toEqual(["lobby.example.com", "factions.example.com", "minigames.example.com"]);
    expect(doc.hasTable("query")).toBe(true);
    expect(doc.has("", "player-info-forwarding-mode")).toBe(true);
  });

  it("changes exactly one line for a scalar edit and keeps every comment", () => {
    const text = DEFAULT_TOML();
    const doc = TomlDocument.parse(text);
    expect(doc.setValue("", "bind", "0.0.0.0:25577")).toBe(true);
    expect(doc.setValue("advanced", "connection-timeout", 7000)).toBe(true);
    expect(doc.setValue("query", "enabled", true)).toBe(true);
    expect(doc.setValue("", "motd", "<green>Hi \"there\"")).toBe(true);
    const out = doc.toString();
    expect(changedLines(text, out)).toEqual([
      ['bind = "0.0.0.0:25565"', 'bind = "0.0.0.0:25577"'],
      ['motd = "<#09add3>A Velocity Server"', 'motd = "<green>Hi \\"there\\""'],
      ["connection-timeout = 5000", "connection-timeout = 7000"],
      ["enabled = false", "enabled = true"],
    ]);
    expect(commentLines(out)).toEqual(commentLines(text));
    expect(parse(out)).toMatchObject({ bind: "0.0.0.0:25577", motd: '<green>Hi "there"' });
  });

  it("leaves the file untouched when the value is already equal", () => {
    const text = DEFAULT_TOML();
    const doc = TomlDocument.parse(text);
    expect(doc.setValue("", "online-mode", true)).toBe(false);
    expect(doc.setValue("servers", "try", ["lobby"])).toBe(false);
    expect(doc.toString()).toBe(text);
  });

  it("replaces a multi-line array value in place", () => {
    const doc = TomlDocument.parse(DEFAULT_TOML());
    doc.setValue("servers", "try", ["lobby", "survival"]);
    expect(doc.toString()).toContain('try = [\n    "lobby",\n    "survival"\n]\n\n[forced-hosts]');
    doc.setValue("servers", "try", []);
    expect(doc.get("servers", "try")).toEqual([]);
  });

  it("replaces a table body keeping its header comment block and attached comments", () => {
    const text = DEFAULT_TOML();
    const doc = TomlDocument.parse(text);
    doc.replaceTableBody("servers", [
      { key: "lobby", value: "127.0.0.1:30066" },
      { key: "survival", value: "bf-survival:25565" },
      { key: "try", value: ["lobby", "survival"] },
    ]);
    const out = doc.toString();
    expect(out).toContain(
      [
        "[servers]",
        "# Configure your servers here. Each key represents the server's name, and the value",
        "# represents the IP address of the server to connect to.",
        'lobby = "127.0.0.1:30066"',
        'survival = "bf-survival:25565"',
        "",
        "# In what order we should try servers when a player logs in or is kicked from a server.",
        "try = [",
        '    "lobby",',
        '    "survival"',
        "]",
        "",
        "[forced-hosts]",
      ].join("\n"),
    );
    expect(commentLines(out)).toEqual(commentLines(text));
    expect(doc.data()["servers"]).toEqual({ lobby: "127.0.0.1:30066", survival: "bf-survival:25565", try: ["lobby", "survival"] });
  });

  it("writes quoted forced-host keys and an empty table body", () => {
    const doc = TomlDocument.parse(DEFAULT_TOML());
    doc.replaceTableBody("forced-hosts", [
      { key: "play.example.com", value: ["lobby"] },
      { key: "xn--bcher-kva.example", value: ["lobby", "survival"] },
    ]);
    expect(doc.get("forced-hosts", "xn--bcher-kva.example")).toEqual(["lobby", "survival"]);
    expect(doc.toString()).toContain('[forced-hosts]\n# Configure your forced hosts here.\n"play.example.com" = [\n    "lobby"\n]\n');
    doc.replaceTableBody("forced-hosts", []);
    expect(doc.get("", "forced-hosts")).toEqual({});
    expect(doc.toString()).toContain("[forced-hosts]\n# Configure your forced hosts here.\n\n[advanced]");
  });

  it("inserts missing keys and tables", () => {
    const doc = TomlDocument.parse(DEFAULT_TOML());
    doc.setValue("advanced", "brand-new", 1);
    doc.setValue("", "root-new", "x");
    doc.ensureTable("custom");
    doc.setValue(["custom"], "flag", true);
    const data = doc.data();
    expect(data).toMatchObject({ "root-new": "x", custom: { flag: true } });
    expect((data["advanced"] as Record<string, unknown>)["brand-new"]).toBe(1);
    expect(doc.toString()).toMatch(/enable-player-address-logging = true\nroot-new = "x"\n\n\[ping-passthrough\]/);
    expect(doc.toString().endsWith('[custom]\nflag = true\n')).toBe(true);
  });
});

describe("TomlDocument edge cases", () => {
  it("handles comments, literal/multi-line strings, inline tables and dotted keys", () => {
    const text = [
      "# top",
      "title = 'lit\"eral' # inline comment",
      'multi = """',
      "line one",
      'still "quoted" """',
      "lit = '''",
      "raw \\n '''",
      "arr = [ # c1",
      '  "a", # c2',
      '  ["nested", 1],',
      "  { x = 1, y = [2, 3] },",
      "]",
      "point = { x = 1, y = 2 }",
      'site."google.com" = true',
      "date = 1979-05-27 07:32:00Z",
      "",
      "[ table . 'quoted key' ]",
      "n = -1_000 # num",
      "",
    ].join("\n");
    const doc = TomlDocument.parse(text);
    expect(doc.toString()).toBe(text);
    expect(doc.keys("")).toEqual([["title"], ["multi"], ["lit"], ["arr"], ["point"], ["site", "google.com"], ["date"]]);
    expect(doc.get(["table", "quoted key"], "n")).toBe(-1000);
    doc.setValue("", "title", "new");
    doc.setValue("", ["site", "google.com"], false);
    doc.setValue(["table", "quoted key"], "n", 5);
    doc.setValue("", "multi", "short");
    const out = doc.toString();
    expect(out).toContain('title = "new" # inline comment');
    expect(out).toContain('multi = "short"\nlit = ');
    expect(out).toContain('site."google.com" = false');
    expect(out).toContain("n = 5 # num");
    expect(parse(out)).toMatchObject({ title: "new", multi: "short", site: { "google.com": false }, table: { "quoted key": { n: 5 } } });
  });

  it("preserves CRLF line endings", () => {
    const text = DEFAULT_TOML().replace(/\n/g, "\r\n");
    const doc = TomlDocument.parse(text);
    expect(doc.toString()).toBe(text);
    doc.setValue("servers", "try", ["a", "b"]);
    doc.setValue("", "new-key", 1);
    const out = doc.toString();
    expect(out.replace(/\r\n/g, "")).not.toContain("\n");
  });

  it("builds documents from scratch", () => {
    const doc = TomlDocument.parse("");
    doc.setValue("", "secret", "abc");
    doc.setValue("forwarding", "enabled", true);
    expect(doc.toString()).toBe('secret = "abc"\n\n[forwarding]\nenabled = true\n');
  });

  it("rejects invalid input and rolls back invalid edits", () => {
    expect(() => TomlDocument.parse('a = "unterminated')).toThrow(TomlSyntaxError);
    expect(() => TomlDocument.parse("a = 1\na = 2")).toThrow(TomlEditError);
    const doc = TomlDocument.parse("[a]\nx = 1\n");
    expect(() => doc.setValue("", "a", 1)).toThrow(TomlEditError);
    expect(doc.toString()).toBe("[a]\nx = 1\n");
    expect(() => doc.replaceTableBody("a", [{ key: "k", value: 1 }, { key: "k", value: 2 }])).toThrow(/duplicate key/);
    const aot = TomlDocument.parse("[[srv]]\nname = 'x'\n");
    expect(() => aot.setValue("srv", "name", "y")).toThrow(/array of tables/);
  });

  it("escapes strings per the TOML spec", () => {
    expect(formatString('a"b\\c\nd\te\u0001')).toBe('"a\\"b\\\\c\\nd\\te\\u0001"');
    const doc = TomlDocument.parse("");
    doc.setValue("", "s", 'tricky "\\\n\u0007 ünï');
    expect(doc.get("", "s")).toBe('tricky "\\\n\u0007 ünï');
  });
});
