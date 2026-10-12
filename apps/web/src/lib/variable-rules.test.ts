import { describe, expect, it } from "vitest";
import { parseRules } from "@blockforge/eggs";
import { parseRuleString } from "./rule-syntax";
import { inputForRules } from "./variable-rules";
import {
  cheapVariableCheck,
  loadVariableRules,
  unsupportedVariableRules,
  validateVariable,
  variableRulesReady,
} from "./variable-validation";

/*
 * The rule engine itself is `@blockforge/eggs` (tested there against real eggs). These tests pin
 * the behaviour the web relies on: the same verdicts the server will give once the lazily loaded
 * engine is ready, certain-only checks before that, and the input picker.
 */
const v = (rules: string) => ({ name: "Value", envName: "VALUE", rules });

describe("before the rule engine has loaded", () => {
  it("runs only required / maximum-length checks, with the engine's messages", () => {
    expect(variableRulesReady()).toBe(false);
    expect(validateVariable(v("required|string"), "  ")).toBe("Value is required.");
    expect(validateVariable(v("string|max:3"), "abcd")).toBe("Value may not be greater than 3 characters.");
    // Everything else waits for the engine (the server validates on submit anyway).
    expect(validateVariable(v("required|integer|between:1,255"), "999")).toBeNull();
    expect(validateVariable(v("alpha_dash"), "my world")).toBeNull();
    expect(validateVariable(v("required|regex:/^(true|false)$/"), "maybe")).toBeNull();
    expect(unsupportedVariableRules("required|starts_with:x")).toEqual([]);
    // `max` is a numeric bound for numbers, not a length.
    expect(cheapVariableCheck(v("integer|max:5"), "123456")).toBeNull();
  });
});

describe("validateVariable (shared @blockforge/eggs rules, once loaded)", () => {
  const ok = (rules: string, value: string) =>
    expect(validateVariable(v(rules), value), `${rules} ← ${value}`).toBeNull();
  const bad = (rules: string, value: string) =>
    expect(validateVariable(v(rules), value), `${rules} ← ${value}`).not.toBeNull();

  it("loads once", async () => {
    const a = loadVariableRules();
    expect(loadVariableRules()).toBe(a);
    await a;
    expect(variableRulesReady()).toBe(true);
  });
  it("required / optional", () => {
    bad("required|string", "");
    bad("required|string", "   ");
    ok("nullable|string|max:5", "");
  });
  it("types and sizes", () => {
    ok("required|integer|between:1,255", "255");
    bad("required|integer|between:1,255", "256");
    bad("integer", "4.2");
    ok("string|max:3", "abc");
    bad("string|max:3", "abcd");
    ok("boolean", "1");
    bad("boolean", "yes");
    ok("alpha_dash", "my-world_2");
    bad("alpha_dash", "my world");
  });
  it("in / regex (including '|' inside the pattern)", () => {
    ok("in:a,b", "b");
    bad("in:a,b", "c");
    ok("required|regex:/^(true|false)$/", "true");
    bad("required|regex:/^(true|false)$/", "maybe");
    bad("regex:/^[a-z0-9_]+\\.jar$/", "../evil.sh");
  });
  it("names the variable in messages", () => {
    expect(validateVariable({ name: "Max players", envName: "MAX", rules: "required" }, "")).toMatch(
      /Max players/,
    );
  });
  it("reports unsupported rules instead of silently enforcing them", () => {
    ok("required|starts_with:x", "abc");
    expect(unsupportedVariableRules("required|starts_with:x|string")).toEqual(["starts_with"]);
  });
  it("cheap checks agree with the engine wherever they report", () => {
    const cases: Array<[string, string]> = [
      ["required|string", ""],
      ["required|string|max:20", " "],
      ["nullable|string|max:3", "abcd"],
      ["max:2", "ééé"],
      ["required|max:64", "x".repeat(65)],
    ];
    for (const [rules, value] of cases) {
      const cheap = cheapVariableCheck(v(rules), value);
      expect(cheap, rules).not.toBeNull();
      expect(validateVariable(v(rules), value), rules).toBe(cheap);
    }
  });
});

describe("rule-string parsing parity with @blockforge/eggs", () => {
  it("reads rule strings exactly like the engine", () => {
    const corpus = [
      "required|string|max:20",
      "required|integer|between:1,255",
      "nullable|in:a,b,c",
      'in:"a,b",c,"d""e"," f "',
      'in:"x\\"y",z',
      "int|bool|Required",
      "required|regex:/^(true|false)$/",
      "regex:/^(a|b|c)$/i|max:5",
      "regex:#^[a-z|]+$#|string",
      "required|regex:/^(unclosed|max:3",
      "not_regex:/^(x|y)$/|string",
      "|required||max:3|",
      "between:1,64|numeric",
      "alpha_dash|starts_with:x,y",
    ];
    for (const rules of corpus) {
      expect(parseRuleString(rules), rules).toEqual(
        parseRules(rules).map((r) => ({ name: r.name, params: r.params })),
      );
    }
  });
});

describe("inputForRules", () => {
  it("picks a fitting input", () => {
    expect(inputForRules("required|in:1,2,3")).toEqual({
      kind: "select",
      options: ["1", "2", "3"],
      optional: false,
    });
    expect(inputForRules("nullable|in:a,b")).toMatchObject({ kind: "select", optional: true });
    expect(inputForRules("boolean")).toEqual({ kind: "boolean" });
    expect(inputForRules("required|integer|between:1,64")).toEqual({
      kind: "number",
      integer: true,
      min: 1,
      max: 64,
    });
    expect(inputForRules("nullable|string|max:20")).toEqual({ kind: "text", maxLength: 20 });
    expect(inputForRules("regex:/^(a|b)$/")).toEqual({ kind: "text", maxLength: undefined });
  });
});
