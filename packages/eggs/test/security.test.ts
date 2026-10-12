import { afterEach, describe, expect, it } from "vitest";
import type { ConfigFileRule } from "@blockforge/contracts";
import {
  applyConfigFileRule,
  applyReplacements,
  buildEggEnvironment,
  parseEgg,
  parsePath,
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
