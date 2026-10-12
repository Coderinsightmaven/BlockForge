import { describe, expect, it } from "vitest";
import { parse as parseYaml } from "yaml";
import type { ConfigFileRule } from "@blockforge/contracts";
import {
  applyConfigFileRule,
  editXml,
  getIniValue,
  getXmlValue,
  parseEgg,
  parsePath,
  templateFromPreview,
  type PlaceholderContext,
} from "../src/index.js";
import { eggFixture, fixture } from "./helpers.js";

const ctx: PlaceholderContext = {
  serverId: "6f1c2a7e-8a4b-4c1d-9e2f-0a1b2c3d4e5f",
  serverName: "My Server",
  primary: { ip: "0.0.0.0", port: 25570 },
  memoryMiB: 4096,
  env: { MAX_USERS: "42", MAX_SLOTS: "16", SERVER_NAME: "Factory §1", SERVER_DESC: "desc", SERVER_USERNAME: "user", SERVER_TOKEN: "tok", SAVE_INTERVAL: "10", SAVE_SLOTS: "5", AFK_KICK: "0", SERVER_PASSWORD: "" },
  dockerInterface: "172.18.0.1",
};

const ruleOf = (egg: string, i = 0): ConfigFileRule => templateFromPreview(parseEgg(eggFixture(egg), { category: "x" })).configFiles[i]!;

function changedLines(a: string, b: string): Array<[string, string]> {
  const x = a.split("\n");
  const y = b.split("\n");
  expect(y.length).toBe(x.length);
  return x.flatMap((l, i) => (l === y[i] ? [] : [[l, y[i]!] as [string, string]]));
}

describe("properties (Minecraft eggs)", () => {
  const rule = ruleOf("ptero-egg-paper.json");

  it("edits only the targeted keys of a real server.properties", () => {
    const before = fixture("configs/vanilla-26.3.server.properties");
    const r = applyConfigFileRule(rule, before, ctx);
    expect(r.changed).toBe(true);
    expect(r.warnings).toEqual([]);
    expect(changedLines(before, r.content).sort()).toEqual(
      [
        ["query.port=25565", "query.port=25570"],
        ["server-ip=", "server-ip=0.0.0.0"],
        ["server-port=25565", "server-port=25570"],
      ].sort(),
    );
    expect(applyConfigFileRule(rule, r.content, ctx)).toMatchObject({ changed: false });
  });

  it("creates the file when missing and escapes non-ASCII like Wings", () => {
    const created = applyConfigFileRule(rule, null, ctx);
    expect(created.content).toBe("server-ip=0.0.0.0\nserver-port=25570\nquery.port=25570\n");
    const motd = applyConfigFileRule({ path: "server.properties", parser: "properties", find: { motd: "{{env.SERVER_NAME}}" } }, "motd=old\n", ctx);
    expect(motd.content).toBe("motd=Factory \\u00A71\n");
  });

  it("conditional entries only apply to matching values", () => {
    const r: ConfigFileRule = { path: "server.properties", parser: "properties", find: { "online-mode": { true: "false" }, missing: { x: "y" } } };
    expect(applyConfigFileRule(r, "online-mode=true\n", ctx).content).toBe("online-mode=false\n");
    expect(applyConfigFileRule(r, "online-mode=false\n", ctx).changed).toBe(false);
  });
});

describe("yaml (BungeeCord egg on a real generated config.yml)", () => {
  const rule = ruleOf("ptero-egg-bungeecord.json");
  const before = fixture("configs/bungeecord-config.yml");

  it("sets listeners[0] values and rewrites localhost server addresses via regex", () => {
    const withLocal = before.replace("address: localhost:25565", "address: localhost:25566");
    const r = applyConfigFileRule(rule, withLocal, ctx);
    expect(r.warnings).toEqual([]);
    const data = parseYaml(r.content);
    expect(data.listeners[0].query_port).toBe(25570);
    expect(data.listeners[0].host).toBe("0.0.0.0:25570");
    expect(data.servers.lobby.address).toBe("172.18.0.1:25566");
    expect(changedLines(withLocal, r.content).sort()).toEqual(
      [
        ["    address: localhost:25566", "    address: 172.18.0.1:25566"],
        ["  host: 0.0.0.0:25577", "  host: 0.0.0.0:25570"],
        ["- query_port: 25577", "- query_port: 25570"],
      ].sort(),
    );
    expect(applyConfigFileRule(rule, r.content, ctx).changed).toBe(false);
  });

  it("leaves non-matching addresses alone and keeps comments when inserting keys", () => {
    const other = before.replace("address: localhost:25565", "address: 10.0.0.5:25565");
    expect(parseYaml(applyConfigFileRule(rule, other, ctx).content).servers.lobby.address).toBe("10.0.0.5:25565");
    const commented = "# header comment\nlisteners:\n- host: 0.0.0.0:1 # inline\n  motd: hi\n";
    const r = applyConfigFileRule(rule, commented, ctx);
    expect(r.content).toBe("# header comment\nlisteners:\n- host: 0.0.0.0:25570 # inline\n  motd: hi\n  query_port: 25570\n");
  });

  it("creates nested keys, handles missing files, CRLF and BOM", () => {
    const rule2: ConfigFileRule = { path: "settings.yml", parser: "yaml", find: { "server.port": "{{server.build.default.port}}", "server.name": "{{server.name}}" } };
    expect(applyConfigFileRule(rule2, null, ctx).content).toBe("server:\n  port: 25570\n  name: My Server\n");
    const crlf = "\uFEFF# c\r\nserver:\r\n  port: 1\r\nother: true\r\n";
    const out = applyConfigFileRule(rule2, crlf, ctx).content;
    expect(out).toBe("\uFEFF# c\r\nserver:\r\n  port: 25570\r\n  name: My Server\r\nother: true\r\n");
    expect(applyConfigFileRule(rule2, "a: [unclosed", ctx).warnings.join(" ")).toMatch(/not valid YAML/);
  });
});

describe("json (Factorio egg on the real server-settings.example.json)", () => {
  const rule = ruleOf("pelican-games-standalone-egg-pterodactyl-factorio.json");
  const before = fixture("configs/factorio-server-settings.example.json");

  it("replaces values in place and keeps the original layout", () => {
    const r = applyConfigFileRule(rule, before, ctx);
    const data = JSON.parse(r.content);
    expect(data.name).toBe("Factory §1");
    expect(data.max_players).toBe(16);
    expect(data.autosave_slots).toBe(5);
    expect(data.game_password).toBe("");
    expect(r.content).toContain('"tags": [ "game", "tags" ],');
    expect(r.content).toContain('\n\n  "_comment_max_players"');
    expect(r.warnings.filter((w) => /re-serialised/.test(w))).toEqual([]);
    const lines = changedLines(before, r.content).map(([, b]) => b.trim());
    expect(lines.every((l) => /^"(name|description|max_players|username|token|autosave_interval|autosave_slots|afk_autokick_interval|game_password)"/.test(l))).toBe(true);
  });

  it("creates missing keys and files", () => {
    const rule2: ConfigFileRule = { path: "config.json", parser: "json", find: { "net.port": "{{server.build.default.port}}", flag: "on" } };
    expect(applyConfigFileRule(rule2, null, ctx).content).toBe('{\n    "net": {\n        "port": 25570\n    },\n    "flag": "on"\n}\n');
    expect(applyConfigFileRule(rule2, '{\n  "a": 1\n}\n', ctx).content).toBe('{\n  "a": 1,\n  "net": {\n    "port": 25570\n  },\n  "flag": "on"\n}\n');
    expect(applyConfigFileRule(rule2, "{oops", ctx)).toMatchObject({ changed: false });
  });
});

describe("ini (Mumble egg on the real mumble-server.ini)", () => {
  const rule = ruleOf("ptero-egg-mumble-server.json");
  const before = fixture("configs/mumble-server.ini");

  it("edits existing keys, adds commented-out ones and keeps comments", () => {
    const r = applyConfigFileRule(rule, before, ctx);
    expect(getIniValue(r.content, "port")).toBe("25570");
    expect(getIniValue(r.content, "users")).toBe("42");
    expect(getIniValue(r.content, "database")).toBe("/home/container/murmur.sqlite");
    expect(getIniValue(r.content, "logfile")).toBe("/home/container/murmur.log");
    expect(getIniValue(r.content, "host")).toBe("0.0.0.0");
    expect(r.content).toContain(";logfile=mumble-server.log");
    expect(r.content.split("\n").filter((l) => l.startsWith(";")).length).toBe(before.split("\n").filter((l) => l.startsWith(";")).length);
    // new keys go into the section-less part, before [Ice]
    expect(r.content.indexOf("logfile=/home/container")).toBeLessThan(r.content.indexOf("[Ice]"));
    expect(applyConfigFileRule(rule, r.content, ctx).changed).toBe(false);
  });

  it("supports sections (OpenTTD)", () => {
    const rule2 = ruleOf("pelican-games-standalone-egg-openttd.json");
    const cfg = "[misc]\nx = 1\n\n[network]\nserver_port = 3979\nlan_internet = 1\n";
    const r = applyConfigFileRule(rule2, cfg, { ...ctx, env: { srv_name: "TTD", srv_advertise: "true" } });
    expect(r.content).toBe("[misc]\nx = 1\n\n[network]\nserver_port = 25570\nlan_internet = 0\nserver_name = TTD\nserver_advertise = true\n");
  });
});

describe("xml (Trackmania egg)", () => {
  const rule = ruleOf("pelican-games-standalone-egg-trackmania2020.json");
  // Representative excerpt of Nadeo's dedicated_cfg.txt layout (not downloaded).
  const before = [
    '<?xml version="1.0" encoding="utf-8" ?>',
    "<dedicated>",
    "\t<!-- server -->",
    "\t<server_options>",
    "\t\t<name></name>",
    "\t\t<password>old</password>",
    "\t\t<max_players>32</max_players>",
    "\t</server_options>",
    "\t<system_config>",
    "\t\t<server_port>2350</server_port>",
    "\t</system_config>",
    "</dedicated>",
    "",
  ].join("\n");

  it("sets element text, creates missing elements and keeps formatting", () => {
    const r = applyConfigFileRule(rule, before, { ...ctx, env: { SERVER_NAME: "A & B <x>", SERVER_PASSWORD: "pw", SPECTATOR_PASSWORD: "", MAX_PLAYERS: "64", MAX_SPECTATORS: "8", XMLRPC_PORT: "5000", MASTER_SERVER_LOGIN: "login", MASTER_SERVER_PASSWORD: "mpw" } });
    expect(getXmlValue(r.content, "dedicated.server_options.name")).toBe("A & B <x>");
    expect(r.content).toContain("<name>A &amp; B &lt;x&gt;</name>");
    expect(getXmlValue(r.content, "dedicated.system_config.server_port")).toBe("25570");
    expect(getXmlValue(r.content, "dedicated.masterserver_account.login")).toBe("login");
    expect(r.content).toContain("\t<!-- server -->");
    expect(r.content).toContain("\t\t<max_spectators>8</max_spectators>\n\t</server_options>");
  });

  it("sets attributes with [attr='value'] and handles self-closing elements", () => {
    const x = '<cfg>\n  <port value="1"/>\n  <name/>\n</cfg>\n';
    const r = editXml(x, [
      { match: "cfg.port", ifValue: null, value: "[value='25570']" },
      { match: "cfg.name", ifValue: null, value: "hi" },
      { match: "cfg.extra", ifValue: null, value: "[enabled='true']" },
    ]);
    expect(r.text).toBe('<cfg>\n  <port value="25570"/>\n  <name>hi</name>\n  <extra enabled="true"></extra>\n</cfg>\n');
    expect(() => editXml("<a><b></a>", [{ match: "a.b", ifValue: null, value: "x" }])).toThrow();
    expect(applyConfigFileRule({ path: "x.xml", parser: "xml", find: { "a.b": "1" } }, "<a><b></a>", ctx).warnings.join(" ")).toMatch(/not valid XML/);
    expect(applyConfigFileRule({ path: "x.xml", parser: "xml", find: { "root.port": "{{server.build.default.port}}" } }, null, ctx).content).toBe(
      '<?xml version="1.0" encoding="utf-8"?>\n<root>\n  <port>25570</port>\n</root>\n',
    );
  });
});

describe("file (FiveM egg)", () => {
  const rule = ruleOf("pelican-games-standalone-egg-five-m.json");

  it("replaces lines by prefix and skips missing files", () => {
    const cfg = 'endpoint_add_tcp "0.0.0.0:30120"\r\nendpoint_add_udp "0.0.0.0:30120"\r\n# comment\r\nsv_maxclients 48\r\nsv_hostname "x"\r\n';
    const r = applyConfigFileRule(rule, cfg, { ...ctx, env: { SERVER_HOSTNAME: "My FiveM", FIVEM_LICENSE: "lic", STEAM_WEBAPIKEY: "", MAX_PLAYERS: "32" } });
    expect(r.content).toBe('endpoint_add_tcp "0.0.0.0:25570"\r\nendpoint_add_udp "0.0.0.0:25570"\r\n# comment\r\nsv_maxclients 32\r\nsv_hostname "My FiveM"\r\n');
    expect(applyConfigFileRule(rule, null, ctx)).toMatchObject({ changed: false, content: "" });
  });
});

describe("placeholders and paths", () => {
  it("leaves unknown placeholders and reports them", () => {
    const r = applyConfigFileRule({ path: "a.properties", parser: "properties", find: { a: "{{server.nope}}", b: "{{config.docker.interface}}" } }, "", { ...ctx, dockerInterface: null });
    expect(r.content).toBe("a={{server.nope}}\nb={{config.docker.interface}}\n");
    expect(r.warnings).toHaveLength(2);
  });

  it("resolves Pterodactyl and Pelican spellings", () => {
    const find = {
      a: "{{server.build.default.ip}}:{{server.allocations.default.port}}",
      b: "{{server.build.memory}}/{{server.build.memory_limit}}/{{env.SERVER_MEMORY}}",
      c: "{{env.MAX_USERS}} {{server.build.env.MAX_USERS}} {{server.environment.MAX_USERS}} {{ server.uuid }}",
    };
    const r = applyConfigFileRule({ path: "a.properties", parser: "properties", find }, null, ctx);
    expect(r.content).toBe(`a=0.0.0.0\\:25570\nb=4096/4096/4096\nc=42 42 42 ${ctx.serverId}\n`);
  });

  it("parses Wings paths", () => {
    expect(parsePath("listeners[0].query_port")).toEqual(["listeners", 0, "query_port"]);
    expect(parsePath("servers.*.address")).toEqual(["servers", "*", "address"]);
    expect(parsePath("a[1][2].b")).toEqual(["a", 1, 2, "b"]);
    expect(() => parsePath("a..b")).toThrow();
  });

  it("wildcards over lists and type coercion", () => {
    const r = applyConfigFileRule({ path: "c.json", parser: "json", find: { "list.*.port": "{{server.build.default.port}}", "list[0].name": "007", "flag": "true" } }, '{"list":[{"port":1},{"port":2}],"flag":false}', ctx);
    expect(JSON.parse(r.content)).toEqual({ list: [{ port: 25570, name: 7 }, { port: 25570 }], flag: "true" });
  });
});
