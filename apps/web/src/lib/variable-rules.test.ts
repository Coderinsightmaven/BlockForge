import { describe, expect, it } from "vitest";
import { inputForRules, unsupportedRules, validateVariableValue } from "./variable-rules";

/*
 * The rule engine itself is `@blockforge/eggs` (tested there against real eggs). These tests pin
 * the behaviour the web relies on: the same verdicts the server will give, and the input picker.
 */
const v = (rules: string) => ({ name: "Value", envName: "VALUE", rules });

describe("validateVariableValue (shared @blockforge/eggs rules)", () => {
  const ok = (rules: string, value: string) =>
    expect(validateVariableValue(v(rules), value), `${rules} ← ${value}`).toBeNull();
  const bad = (rules: string, value: string) =>
    expect(validateVariableValue(v(rules), value), `${rules} ← ${value}`).not.toBeNull();

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
    expect(validateVariableValue({ name: "Max players", envName: "MAX", rules: "required" }, "")).toMatch(
      /Max players/,
    );
  });
  it("reports unsupported rules instead of silently enforcing them", () => {
    ok("required|starts_with:x", "abc");
    expect(unsupportedRules("required|starts_with:x|string")).toEqual(["starts_with"]);
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
