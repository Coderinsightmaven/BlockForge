import { parseRuleString } from "./rule-syntax";

/*
 * Picking an input for an egg variable from its rule string. Validation lives in
 * `variable-validation.ts` (the shared `@blockforge/eggs` engine, loaded lazily); this module stays
 * dependency-free so the wizard and the Startup tab render without it.
 */

export type VariableInput =
  | { kind: "select"; options: string[]; optional: boolean }
  | { kind: "boolean" }
  | { kind: "number"; min?: number; max?: number; integer: boolean }
  | { kind: "text"; maxLength?: number };

/** The input that best fits a rule string (select for `in:`, switch for `boolean`, …). */
export function inputForRules(rules: string): VariableInput {
  const parsed = parseRuleString(rules);
  const get = (n: string) => parsed.find((r) => r.name === n);
  const inRule = get("in");
  if (inRule && inRule.params.length > 0)
    return { kind: "select", options: inRule.params, optional: !get("required") };
  if (get("boolean")) return { kind: "boolean" };
  const between = get("between");
  const min = get("min")?.params[0] ?? between?.params[0];
  const max = get("max")?.params[0] ?? between?.params[1];
  if (get("integer") || get("numeric")) {
    return {
      kind: "number",
      integer: !!get("integer"),
      min: min !== undefined ? Number(min) : undefined,
      max: max !== undefined ? Number(max) : undefined,
    };
  }
  return {
    kind: "text",
    maxLength: max !== undefined && Number.isFinite(Number(max)) ? Number(max) : undefined,
  };
}
