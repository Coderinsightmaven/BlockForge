import { describe, expect, it } from "vitest";
import {
  HIDDEN_VALUE,
  buildEggEnvironment,
  createDoneMatcher,
  parseEgg,
  pcreToRegExp,
  resolveStartupForDisplay,
  splitRules,
  stripAnsi,
  templateFromPreview,
  unsupportedRules,
  validateVariableValue,
} from "../src/index.js";
import { eggFixture } from "./helpers.js";

const v = (rules: string) => ({ name: "Field", envName: "FIELD", rules });
const ok = (rules: string, value: string) => validateVariableValue(v(rules), value);

describe("variable rules (Laravel semantics)", () => {
  it("required / nullable / empty values (review #5)", () => {
    expect(ok("required|string", "")).toBe("Field is required.");
    expect(ok("required|string", "   ")).toBe("Field is required.");
    expect(ok("nullable|integer", "")).toBeNull();
    // without nullable, "" is validated by the other rules
    expect(ok("integer|max:5", "")).toMatch(/integer/);
    expect(ok("string|max:5", "")).toBeNull();
    expect(ok("in:a,b", "")).toMatch(/one of/);
    // whitespace is not "empty": it is validated like any value
    expect(ok("nullable|integer", "  ")).toMatch(/integer/);
    expect(ok("nullable|alpha_num", " ")).toMatch(/letters and numbers/);
  });

  it("integer / numeric / boolean", () => {
    expect(ok("integer", "42")).toBeNull();
    expect(ok("integer", "-7")).toBeNull();
    expect(ok("integer", "007")).toBeNull(); // review #5: leading zeros accepted
    expect(ok("integer", " 5")).toMatch(/integer/); // surrounding whitespace refused
    expect(ok("integer", "5 ")).toMatch(/integer/);
    expect(ok("numeric", " 5")).toMatch(/number/);
    expect(ok("integer", "4.2")).toMatch(/integer/);
    expect(ok("integer", "9223372036854775808")).toMatch(/integer/);
    expect(ok("numeric", "4.2e3")).toBeNull();
    expect(ok("numeric", ".5")).toBeNull();
    expect(ok("numeric", "0x1A")).toMatch(/number/);
    expect(ok("boolean", "1")).toBeNull();
    expect(ok("boolean", "0")).toBeNull();
    expect(ok("boolean", "true")).toMatch(/0 or 1/);
  });

  it("alpha family, url, ip, in/not_in", () => {
    expect(ok("alpha", "Ünïcode")).toBeNull();
    expect(ok("alpha", "a1")).toMatch(/letters/);
    expect(ok("alpha_num", "abc123")).toBeNull();
    expect(ok("alpha_dash", "gm_flatgrass-2")).toBeNull();
    expect(ok("alpha_dash", "a b")).toMatch(/dashes/);
    expect(ok("url", "https://example.com/x.png")).toBeNull();
    expect(ok("url", "not a url")).toMatch(/URL/);
    expect(ok("url", "javascript:alert(1)")).toMatch(/URL/);
    expect(ok("ip", "10.0.0.1")).toBeNull();
    expect(ok("ip", "2001:db8::1")).toBeNull();
    expect(ok("ip", "999.1.1.1")).toMatch(/IP/);
    expect(ok("required|in:vanilla,oxide,carbon", "oxide")).toBeNull();
    expect(ok("required|in:vanilla,oxide,carbon", "paper")).toMatch(/one of: vanilla, oxide, carbon/);
    expect(ok("not_in:root,admin", "admin")).toMatch(/must not/);
  });

  it("min / max / between / size depend on numeric context", () => {
    expect(ok("required|string|max:9", "1.21.11")).toBeNull();
    expect(ok("required|string|max:6", "1.21.11")).toMatch(/greater than 6 characters/);
    expect(ok("required|integer|max:128", "129")).toMatch(/greater than 128\./);
    expect(ok("required|integer|between:1025,65535", "80")).toMatch(/between 1025 and 65535/);
    expect(ok("required|alpha_num|between:1,6", "latest")).toBeNull();
    expect(ok("nullable|string|alpha_num|size:32", "a".repeat(32))).toBeNull();
    expect(ok("nullable|string|alpha_num|size:32", "a".repeat(31))).toMatch(/must be 32 characters/);
    expect(ok("required|integer|min:1", "0")).toMatch(/at least 1/);
    expect(ok("max:3", "äöü")).toBeNull(); // characters, not bytes
  });

  it("digits / digits_between", () => {
    expect(ok("required|numeric|digits_between:1,5", "100")).toBeNull();
    expect(ok("required|numeric|digits_between:1,5", "123456")).toMatch(/between 1 and 5 digits/);
    expect(ok("digits:4", "1234")).toBeNull();
    expect(ok("digits:4", "12a4")).toMatch(/4 digits/);
  });

  it("regex rules from real eggs", () => {
    const jar = "required|regex:/^([\\w\\d._-]+)(\\.jar)$/";
    expect(ok(jar, "server.jar")).toBeNull();
    expect(ok(jar, "server.zip")).toMatch(/invalid format/);
    expect(ok(jar, "../server.jar")).toMatch(/invalid format/);
    expect(ok("required|regex:/^[\\w.-]*$/|max:64", "pass.word")).toBeNull();
    expect(ok("nullable|regex:/^[0-9\\.\\-]+$/", "1.20.1-47.2.0")).toBeNull();
    expect(ok("regex:/^(a|b)$/i", "B")).toBeNull();
    expect(ok("regex:#^x$#", "x")).toBeNull();
  });

  it("splits rule strings keeping | inside regex", () => {
    expect(splitRules("required|regex:/^(a|b)$/|max:3")).toEqual(["required", "regex:/^(a|b)$/", "max:3"]);
    expect(splitRules(["required", "regex:/^(a|b)$/"])).toEqual(["required", "regex:/^(a|b)$/"]);
    expect(ok("required|regex:/^(foo|bar)$/|max:3", "bar")).toBeNull();
    expect(ok("required|regex:/^(foo|bar)$/|max:3", "baz")).toMatch(/invalid format/);
  });

  it("reports unsupported rules and PCRE-only patterns", () => {
    expect(unsupportedRules("required|string|uuid|json|required_with:X")).toEqual(["uuid", "json", "required_with"]);
    expect(unsupportedRules("nullable|string|max:20")).toEqual([]);
    expect(unsupportedRules("regex:/(?>atomic)/")).toEqual(["regex"]);
    expect(unsupportedRules("required|int|bool")).toEqual([]); // review #6 aliases
    expect(() => pcreToRegExp("/a++/")).toThrow(/possessive/);
    expect(() => pcreToRegExp("/(a)\\1/")).toThrow(/backreferences/);
    expect(() => pcreToRegExp("/a(?=b)/")).toThrow(/lookarounds/);
    expect(pcreToRegExp("/\\Aabc\\z/").source).toBe("^abc$");
    expect(pcreToRegExp("/(?P<n>x)/").test("x")).toBe(true);
    expect(() => pcreToRegExp("noDelimiter")).toThrow();
  });
});

describe("buildEggEnvironment", () => {
  const t = templateFromPreview(parseEgg(eggFixture("ptero-egg-rust.json"), { category: "Survival" }));
  const env = buildEggEnvironment({
    template: t,
    values: { HOSTNAME: "My Rust", WORLD_SIZE: "4000", NOT_A_VARIABLE: "ignored", SERVER_PORT: "1" },
    memoryLimitBytes: 8 * 1024 ** 3 + 512 * 1024,
    primary: { ip: "0.0.0.0", port: 28015 },
    serverId: "6f1c2a7e-8a4b-4c1d-9e2f-0a1b2c3d4e5f",
    location: null,
    allocationLimit: 2,
    timezone: "Europe/Berlin",
  });

  it("sets platform variables (which win) and every template variable", () => {
    expect(env).toMatchObject({
      STARTUP: t.startup,
      SERVER_MEMORY: "8192",
      SERVER_IP: "0.0.0.0",
      SERVER_PORT: "28015",
      P_SERVER_UUID: "6f1c2a7e-8a4b-4c1d-9e2f-0a1b2c3d4e5f",
      P_SERVER_LOCATION: "",
      P_SERVER_ALLOCATION_LIMIT: "2",
      TZ: "Europe/Berlin",
      HOSTNAME: "My Rust",
      WORLD_SIZE: "4000",
      LEVEL: t.variables.find((x) => x.envName === "LEVEL")!.defaultValue,
    });
    expect(env).not.toHaveProperty("NOT_A_VARIABLE");
    expect(Object.keys(env)).toHaveLength(t.variables.length + 8);
    expect(env["STARTUP"]).toContain("{{");
  });

  it("keeps explicit empty strings instead of defaults and rejects NUL bytes", () => {
    const e = buildEggEnvironment({ template: t, values: { WORLD_SEED: "" }, memoryLimitBytes: 1024 ** 3, primary: { ip: "1.2.3.4", port: 1 }, serverId: "x", location: "eu", allocationLimit: 0, timezone: "UTC" });
    expect(e["WORLD_SEED"]).toBe("");
    expect(e["P_SERVER_LOCATION"]).toBe("eu");
    expect(() => buildEggEnvironment({ template: t, values: { HOSTNAME: "a\0b" }, memoryLimitBytes: 1024 ** 3, primary: { ip: "1", port: 1 }, serverId: "x", location: null, allocationLimit: 0, timezone: "UTC" })).toThrow(/control characters/);
  });

  it("resolves the startup command for display, hiding non-viewable values", () => {
    const gm = templateFromPreview(parseEgg(eggFixture("ptero-egg-garrys-mod.json"), { category: "Source" }));
    const values = { SERVER_PORT: "27015", STEAM_ACC: "secret-token", SRCDS_MAP: "gm_construct", SRCDS_APPID: "4020" };
    const out = resolveStartupForDisplay(gm, values, (n) => n !== "STEAM_ACC");
    expect(out).toContain("-port 27015");
    expect(out).toContain("+map gm_construct");
    expect(out).toContain(`+sv_setsteamaccount ${HIDDEN_VALUE}`);
    expect(out).not.toContain("secret-token");
    expect(out).toContain("+maxplayers 32"); // default
    expect(out).toContain('"$LUA_REFRESH"'); // shell references stay as written
  });
});

describe("done matcher", () => {
  it("matches substrings and regex patterns after stripping ANSI", () => {
    const m = createDoneMatcher([")! For help, type ", "regex:^\\[\\d+:\\d+:\\d+ INFO\\]: Listening on"]);
    expect(m('\u001b[32m[12:00:01] [Server thread/INFO]: Done (3.2s)! For help, type "help"\u001b[0m')).toBe(true);
    expect(m("[12:00:01 INFO]: Listening on /0.0.0.0:25577")).toBe(true);
    expect(m("[12:00:01 INFO]: Starting")).toBe(false);
    expect(createDoneMatcher([])("anything")).toBe(false);
    expect(createDoneMatcher(["regex:(unclosed"])("x (unclosed y")).toBe(true); // invalid regex → literal (Wings)
    expect(stripAnsi("\u001b[1;31mred\u001b[0m \u009b0m")).toBe("red ");
  });

  it("works with the Factorio and Valheim done lines", () => {
    const f = templateFromPreview(parseEgg(eggFixture("pelican-games-standalone-egg-pterodactyl-factorio.json"), { category: "x" }));
    const done = createDoneMatcher(f.startupDone);
    expect(f.startupDone.length).toBeGreaterThan(0);
    expect(done(`  1.234 Info ${f.startupDone[0]} something`)).toBe(true);
  });
});
