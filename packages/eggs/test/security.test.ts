import { afterEach, describe, expect, it } from "vitest";
import type { ConfigFileRule } from "@blockforge/contracts";
import {
  applyConfigFileRule,
  applyReplacements,
  buildEggEnvironment,
  createDoneMatcher,
  getIniValue,
  parseCsvParams,
  parseEgg,
  parsePath,
  parseRules,
  splitRules,
  stripAnsi,
  templateFromPreview,
  unquotedStartupVariables,
  validateVariableValue,
  yamlGet,
  yamlSetMany,
  type PlaceholderContext,
} from "../src/index.js";
import { jsonSetInSource } from "../src/json-source.js";
import { eggFixture } from "./helpers.js";

/** Review 2026-10-12 (Grok) — one describe block per finding, each with its exploit. */

const ctx: PlaceholderContext = {
  serverId: "6f1c2a7e-8a4b-4c1d-9e2f-0a1b2c3d4e5f",
  serverName: "srv",
  primary: { ip: "0.0.0.0", port: 25570 },
  memoryMiB: 1024,
  env: {},
  dockerInterface: "172.18.0.1",
};

const originalToString = Object.prototype.toString;
const polluted = () => {
  const probe = {} as Record<string, unknown>;
  return probe["polluted"] !== undefined || probe["address"] !== undefined || probe["x"] !== undefined || ({}).toString !== originalToString;
};

describe("#1 prototype pollution through config-file paths", () => {
  afterEach(() => {
    // Never leave a polluted prototype behind for other tests, even if an assertion failed.
    for (const k of ["polluted", "address", "x"]) delete (Object.prototype as Record<string, unknown>)[k];
    if (Object.prototype.toString !== originalToString) Object.prototype.toString = originalToString;
  });

  const rule = (parser: "json" | "yaml", find: ConfigFileRule["find"]): ConfigFileRule => ({ path: `c.${parser}`, parser, find });

  it.each(["json", "yaml"] as const)("%s: __proto__ / constructor.prototype paths never touch Object.prototype", (parser) => {
    for (const key of ["__proto__.toString", "__proto__.polluted", "constructor.prototype.polluted", "a.__proto__.x", "list[0].__proto__.x", "__proto__[0]"]) {
      const r = applyConfigFileRule(rule(parser, { [key]: "pwned" }), parser === "json" ? '{"a": {}, "list": [{}]}' : "a: {}\nlist:\n- {}\n", ctx);
      expect(polluted(), `${parser} ${key}`).toBe(false);
      expect(r.changed, key).toBe(false);
      expect(r.warnings.join(" "), key).toMatch(/not allowed/);
    }
    const fresh = applyConfigFileRule(rule(parser, { "__proto__.polluted": "yes" }), null, ctx);
    expect(polluted()).toBe(false);
    expect(fresh.content).not.toContain("polluted");
  });

  it.each([
    ["json", '{"servers": {"__proto__": {"address": "localhost:1"}, "lobby": {"address": "localhost:2"}}}\n'],
    ["yaml", "servers:\n  __proto__:\n    address: localhost:1\n  lobby:\n    address: localhost:2\n"],
  ] as const)("%s: a wildcard over a file with an own __proto__ key skips that key", (parser, text) => {
    const r = applyConfigFileRule(
      rule(parser, { "servers.*.address": { "regex:^localhost(:\\d+)$": "{{config.docker.interface}}$1" }, "servers.*.motd": "hi" }),
      text,
      ctx,
    );
    expect(polluted()).toBe(false);
    expect(r.content).toContain("172.18.0.1:2");
    expect(r.content).toContain("localhost:1"); // the own "__proto__" entry is left alone
    expect((r.content.match(/motd/g) ?? []).length).toBe(1);
  });

  it("applyReplacements and the source editors refuse forbidden segments directly", () => {
    const data: Record<string, unknown> = { a: {} };
    const r = applyReplacements(data, [{ match: "a.constructor.prototype.polluted", ifValue: null, replaceWith: "1" }]);
    expect(r.edits).toEqual([]);
    expect(polluted()).toBe(false);
    expect(() => parsePath("x.__proto__")).toThrow(/not allowed/);
    expect(() => parsePath("prototype")).toThrow(/not allowed/);
    expect(() => yamlSetMany("a: 1\n", [{ path: ["__proto__", "polluted"], value: "x" }])).toThrow(/not allowed/);
    expect(() => jsonSetInSource("{}", ["constructor", "prototype", "polluted"], 1)).toThrow(/forbidden/);
    expect(polluted()).toBe(false);
  });

  it("makes such keys an import error and never pollutes while importing", () => {
    const egg = eggFixture("ptero-egg-paper.json");
    // Written as JSON text: in a JS object literal `__proto__:` would not be an own key.
    (egg["config"] as Record<string, unknown>)["files"] = '{"a.json": {"parser": "json", "find": {"__proto__.polluted": "x", "ok": {"__proto__": "y", "constructor": "z"}}}}';
    const p = parseEgg(egg, { category: "x" });
    expect(p.template).toBeNull();
    expect(p.issues.filter((i) => i.code === "CONFIG_KEY_FORBIDDEN")).toHaveLength(3);
    expect(polluted()).toBe(false);
    const v = eggFixture("ptero-egg-paper.json");
    (v["variables"] as Array<Record<string, unknown>>)[0]!["env_variable"] = "__proto__";
    expect(parseEgg(v, { category: "x" }).issues.some((i) => i.code === "VARIABLE_NAME_INVALID")).toBe(true);
  });

  it("buildEggEnvironment refuses forbidden variable names", () => {
    const template = { startup: "x", variables: [{ envName: "__proto__", name: "p", description: "", defaultValue: "v", userViewable: true, userEditable: true, rules: "string", sortOrder: 0 }] };
    expect(() =>
      buildEggEnvironment({ template, values: {}, memoryLimitBytes: 1024 ** 3, primary: { ip: "0.0.0.0", port: 1 }, serverId: "s", location: null, allocationLimit: 0, timezone: "UTC" }),
    ).toThrow(/not allowed/);
    expect(polluted()).toBe(false);
  });
});

const ruleOf = (egg: string, i = 0): ConfigFileRule => templateFromPreview(parseEgg(eggFixture(egg), { category: "x" })).configFiles[i]!;
const withEnv = (env: Record<string, string>): PlaceholderContext => ({ ...ctx, env });
const timed = <T>(fn: () => T): { ms: number; value: T } => {
  const t0 = performance.now();
  const value = fn();
  return { ms: performance.now() - t0, value };
};
// Wall-clock bounds are generous on purpose: shared CI runners are slow and noisy. A backtracking engine on these
// inputs takes ~2^40 steps (hours), so a 1 s ceiling still tells linear from catastrophic.
const LINEAR_MS = 1000;
/** Median time of `runs` calls; used to compare growth across input sizes instead of absolute milliseconds. */
const medianMs = (fn: () => unknown, runs = 5): number => {
  const ms = Array.from({ length: runs }, () => timed(fn).ms).sort((a, b) => a - b);
  return ms[Math.floor(runs / 2)]!;
};

describe("#2 INI injection", () => {
  const openttd = () => ruleOf("pelican-games-standalone-egg-openttd.json");
  const cfg = "[network]\nserver_port = 3979\nserver_name = old\n";

  it("refuses values with CR/LF for existing and inserted keys (exactly one key stays)", () => {
    for (const evil of ["\nrcon_password=x", "x\r\nrcon_password=x", "x\rrcon_password=x", "x\u0000y"]) {
      const r = applyConfigFileRule(openttd(), cfg, withEnv({ srv_name: evil, srv_advertise: "true" }));
      expect(r.content, JSON.stringify(evil)).not.toContain("rcon_password");
      expect((r.content.match(/server_name/g) ?? []).length).toBe(1);
      expect(r.content).toContain("server_name = old");
      expect(r.warnings.join(" ")).toMatch(/control characters/);
    }
    const inserted = applyConfigFileRule(openttd(), "[network]\nserver_port = 1\n", withEnv({ srv_name: "a\nrcon_password=x", srv_advertise: "true" }));
    expect(inserted.content).not.toContain("rcon_password");
    expect(inserted.content).not.toContain("server_name");
  });

  it("still writes normal values (tabs allowed)", () => {
    const r = applyConfigFileRule(openttd(), cfg, withEnv({ srv_name: "My\tServer = 1", srv_advertise: "true" }));
    expect(getIniValue(r.content, "network.server_name")).toBe("My\tServer = 1");
  });
});

describe("#3 file parser injection (FiveM server.cfg)", () => {
  const fivem = () => ruleOf("pelican-games-standalone-egg-five-m.json");
  const cfg = 'sv_hostname "old"\nset sv_licenseKey old\nsv_maxclients 32\n';
  const env = (over: Record<string, string>) => withEnv({ SERVER_HOSTNAME: "x", FIVEM_LICENSE: "lic", STEAM_WEBAPIKEY: "k", MAX_PLAYERS: "32", ...over });

  it("refuses line breaks in values", () => {
    const r = applyConfigFileRule(fivem(), cfg, env({ SERVER_HOSTNAME: 'x"\nadd_ace group.builtin.everyone command allow' }));
    expect(r.content).not.toContain("add_ace");
    expect(r.content).toContain('sv_hostname "old"');
    expect(r.warnings.join(" ")).toMatch(/line breaks/);
  });

  it("escapes quotes and backslashes inside quoted positions", () => {
    const r = applyConfigFileRule(fivem(), cfg, env({ SERVER_HOSTNAME: 'My "cool" \\ server"; add_ace x' }));
    expect(r.content.split("\n")[0]).toBe('sv_hostname "My \\"cool\\" \\\\ server\\"; add_ace x"');
  });

  it("refuses quote, ';' and '\\' in unquoted positions (license line)", () => {
    for (const evil of ["abc; add_ace group.builtin.everyone command allow", 'abc"', "abc\\n"]) {
      const r = applyConfigFileRule(fivem(), cfg, env({ FIVEM_LICENSE: evil }));
      expect(r.content, evil).toContain("set sv_licenseKey old");
      expect(r.warnings.join(" ")).toMatch(/outside quotes/);
    }
    expect(applyConfigFileRule(fivem(), cfg, env({ FIVEM_LICENSE: "cfxk_abc123" })).content).toContain("set sv_licenseKey cfxk_abc123");
  });

  it("never merges several replacements into one line", () => {
    const rule: ConfigFileRule = { path: "server.cfg", parser: "file", find: { "set sv": "set sv_generic 1", "set sv_licenseKey": "set sv_licenseKey {{env.FIVEM_LICENSE}}" } };
    const r = applyConfigFileRule(rule, "set sv_licenseKey old\nset sv_other 2\n", env({ FIVEM_LICENSE: "new" }));
    expect(r.content).toBe("set sv_licenseKey new\nset sv_generic 1\n");
  });
});

describe("#4 linear-time regexes", () => {
  const evil = "a".repeat(40) + "!";

  it("done patterns run on RE2 and lines are capped", () => {
    const m = createDoneMatcher(["regex:(a+)+$", "regex:(a+){10,}$"]);
    const r = timed(() => m(evil));
    expect(r.value).toBe(false);
    expect(r.ms).toBeLessThan(LINEAR_MS);
    const big = timed(() => createDoneMatcher(["regex:x$"])("a".repeat(1_000_000) + "x"));
    expect(big.value).toBe(false); // only the first 8 KiB are inspected
    expect(big.ms).toBeLessThan(2 * LINEAR_MS);
  });

  it("variable regex rules run on RE2", () => {
    const r = timed(() => validateVariableValue({ name: "V", envName: "V", rules: "regex:/^(a+)+$/" }, evil));
    expect(r.value).toMatch(/invalid format/);
    expect(r.ms).toBeLessThan(LINEAR_MS);
    const nested = timed(() => validateVariableValue({ name: "V", envName: "V", rules: "regex:/^(a+){10,}$/" }, evil));
    expect(nested.ms).toBeLessThan(LINEAR_MS);
  });

  it("config conditions run on RE2", () => {
    const rule: ConfigFileRule = { path: "c.json", parser: "json", find: { k: { "regex:(a+)+$": "x", "regex:(a+){10,}b": "y" } } };
    const r = timed(() => applyConfigFileRule(rule, JSON.stringify({ k: evil }), ctx));
    expect(r.value.changed).toBe(false);
    expect(r.ms).toBeLessThan(LINEAR_MS);
  });

  it("refuses at import what RE2 cannot express", () => {
    const egg = eggFixture("ptero-egg-paper.json");
    (egg["variables"] as Array<Record<string, unknown>>)[0]!["rules"] = "required|regex:/^(a)\\1$/";
    (egg["config"] as Record<string, unknown>)["startup"] = JSON.stringify({ done: "regex:(?=lookahead)x" });
    const p = parseEgg(egg, { category: "x" });
    expect(p.issues.find((i) => i.code === "VARIABLE_REGEX_UNUSABLE")?.message).toMatch(/backreferences/);
    expect(p.issues.find((i) => i.code === "DONE_REGEX_INVALID")?.message).toMatch(/lookarounds/);
    expect(validateVariableValue({ name: "V", envName: "V", rules: "regex:/^(a)\\1$/" }, "aa")).toMatch(/cannot be validated/);
  });

  it("stripAnsi is linear", () => {
    // Growth, not absolute time: 16x the input costs ~12-16x when linear and ~256x when quadratic.
    const line = (n: number) => "\u001b[" + ";".repeat(n);
    const small = line(12_500);
    const large = line(200_000);
    stripAnsi(large); // warm up the JIT before measuring
    const ratio = medianMs(() => stripAnsi(large)) / Math.max(medianMs(() => stripAnsi(small)), 0.05);
    expect(ratio).toBeLessThan(40);
    expect(timed(() => stripAnsi(large)).ms).toBeLessThan(LINEAR_MS);
    expect(stripAnsi("\u001b[1;31mred\u001b[0m \u009b0mx \u001b]0;title\u0007y \u001b(Bz")).toBe("red x y z");
  });
});

describe("#5/#6 rule semantics", () => {
  it("int / bool aliases (Terraria NPCSTREAM)", () => {
    const npc = templateFromPreview(parseEgg(eggFixture("pelican-games-standalone-egg-terraria-vanilla.json"), { category: "x" })).variables.find((v) => v.envName === "NPCSTREAM")!;
    expect(npc.rules).toBe("required|int|between:0,60");
    expect(validateVariableValue(npc, "999")).toMatch(/between 0 and 60\./);
    expect(validateVariableValue(npc, "abc")).toMatch(/integer/);
    expect(validateVariableValue(npc, "10")).toBeNull();
    expect(validateVariableValue({ name: "B", envName: "B", rules: "required|bool" }, "true")).toMatch(/0 or 1/);
    expect(validateVariableValue({ name: "B", envName: "B", rules: "required|bool" }, "1")).toBeNull();
  });
});

describe("#7 `$` in substituted values", () => {
  it("user values stay literal in regex replacements; egg-authored $2 still works", () => {
    const bungee = ruleOf("ptero-egg-bungeecord.json");
    const r = applyConfigFileRule(bungee, "servers:\n  lobby:\n    address: localhost:25566\n", { ...ctx, dockerInterface: "10.0.0.1$1" });
    expect(r.content).toContain("address: 10.0.0.1$1:25566");
    const rule: ConfigFileRule = { path: "c.yml", parser: "yaml", find: { motd: { "regex:^(.*)$": "{{env.MOTD}} [$1]" } } };
    for (const v of ["$1", "$'", "${1}", "$$", "$&"]) {
      const out = applyConfigFileRule(rule, "motd: base\n", withEnv({ MOTD: v }));
      expect(yamlGet(out.content, ["motd"]), v).toBe(`${v} [base]`);
    }
  });
});

describe("#8 XML attribute syntax only from the egg template", () => {
  it("writes a user value that looks like [attr='…'] as text", () => {
    const tm = ruleOf("pelican-games-standalone-egg-trackmania2020.json");
    const xml = "<dedicated>\n  <server_options>\n    <name>x</name>\n  </server_options>\n</dedicated>\n";
    const r = applyConfigFileRule(tm, xml, withEnv({ SERVER_NAME: "[admin='true']" }));
    expect(r.content).toContain("<name>[admin='true']</name>");
    expect(r.content).not.toContain('admin="true"');
  });
});

describe("#9 unclosed regex rules", () => {
  it("does not swallow following rules and fails closed", () => {
    expect(parseRules("regex:/unclosed|max:2").map((r) => [r.name, r.unclosed ?? false])).toEqual([
      ["regex", true],
      ["max", false],
    ]);
    expect(validateVariableValue({ name: "V", envName: "V", rules: "regex:/unclosed|max:2" }, "a")).toMatch(/not closed/);
    expect(validateVariableValue({ name: "V", envName: "V", rules: "nullable|regex:/unclosed|max:2" }, "")).toBeNull();
    const egg = eggFixture("ptero-egg-paper.json");
    (egg["variables"] as Array<Record<string, unknown>>)[0]!["rules"] = "regex:/unclosed|max:2|in:a,b";
    const w = parseEgg(egg, { category: "x" }).issues.find((i) => i.code === "VARIABLE_REGEX_UNUSABLE");
    expect(w?.message).toMatch(/not closed.*max, in/);
    // a closed regex containing | is still one rule
    expect(splitRules("required|regex:/^(a|b)$/|max:3")).toEqual(["required", "regex:/^(a|b)$/", "max:3"]);
  });
});

describe("#10 environment values", () => {
  const rust = () => templateFromPreview(parseEgg(eggFixture("ptero-egg-rust.json"), { category: "x" }));
  const gmod = () => templateFromPreview(parseEgg(eggFixture("ptero-egg-garrys-mod.json"), { category: "x" }));
  const input = (template: ReturnType<typeof rust>, values: Record<string, string>, over: Partial<Parameters<typeof buildEggEnvironment>[0]> = {}) => ({
    template,
    values,
    memoryLimitBytes: 1024 ** 3,
    primary: { ip: "0.0.0.0", port: 28015 },
    serverId: "srv",
    location: null,
    allocationLimit: 0,
    timezone: "UTC",
    ...over,
  });

  it("refuses CR/LF and control characters everywhere", () => {
    for (const v of ["a\nb", "a\rb", "a\u001bb", "a\u007fb"]) expect(() => buildEggEnvironment(input(rust(), { HOSTNAME: v }))).toThrow(/control characters/);
    expect(() => buildEggEnvironment(input(rust(), {}, { timezone: "UTC\nX=1" }))).toThrow(/timezone/);
    expect(() => buildEggEnvironment(input(rust(), {}, { location: "eu\r" }))).toThrow(/location/);
    expect(() => buildEggEnvironment(input(rust(), {}, { serverId: "a\nb" }))).toThrow(/serverId/);
    expect(buildEggEnvironment(input(rust(), { HOSTNAME: "tab\there" }))["HOSTNAME"]).toBe("tab\there");
  });

  it("ignores values for non-editable variables unless adminOverride", () => {
    expect(buildEggEnvironment(input(gmod(), { SRCDS_APPID: "1" }))["SRCDS_APPID"]).toBe("4020");
    expect(buildEggEnvironment(input(gmod(), { SRCDS_APPID: "1" }), { adminOverride: true })["SRCDS_APPID"]).toBe("1");
    expect(buildEggEnvironment(input(gmod(), { SRCDS_MAP: "gm_construct" }))["SRCDS_MAP"]).toBe("gm_construct");
  });

  it("warns at import when user-editable variables are used unquoted in startup", () => {
    expect(unquotedStartupVariables(`java -jar {{SERVER_JARFILE}} "$QUOTED" '\${SINGLE}' $BARE \${BRACED}`)).toEqual(["SERVER_JARFILE", "BARE", "BRACED"]);
    const p = parseEgg(eggFixture("ptero-egg-paper.json"), { category: "x" });
    expect(p.issues.find((i) => i.code === "STARTUP_VARIABLE_UNQUOTED")?.message).toMatch(/SERVER_JARFILE/);
  });
});

describe("#11 in/not_in parameters are CSV", () => {
  it("parses quotes and escaped quotes", () => {
    expect(parseCsvParams('"a,b",c')).toEqual(["a,b", "c"]);
    expect(parseCsvParams('"say ""hi""", x ,"y\\"z"')).toEqual(['say "hi"', "x", 'y"z']);
    const v = { name: "V", envName: "V", rules: 'required|in:"a,b",c' };
    expect(validateVariableValue(v, "a,b")).toBeNull();
    expect(validateVariableValue(v, "c")).toBeNull();
    expect(validateVariableValue(v, "a")).toMatch(/one of/);
    expect(validateVariableValue({ name: "V", envName: "V", rules: 'not_in:"x,y"' }, "x,y")).toMatch(/must not/);
  });
});
