import {
  parseRules,
  unsupportedRules as eggsUnsupportedRules,
  validateVariableValue as eggsValidate,
} from "@blockforge/eggs";
import type { TemplateVariable } from "@blockforge/contracts";

/*
 * Egg variable rules (Laravel rule strings). Validation is the shared `@blockforge/eggs`
 * implementation — the same code the control plane uses — so the browser gives instant feedback
 * with identical results; the server still re-validates every value.
 */

export type RuleVariable = Pick<TemplateVariable, "name" | "envName" | "rules">;

/** First error message for `value`, or null when it satisfies every supported rule. */
export function validateVariableValue(variable: RuleVariable, value: string): string | null {
  try {
    return eggsValidate(variable, value);
  } catch (err) {
    // A rule the library cannot evaluate (e.g. an invalid regex): leave it to the server.
    return err instanceof Error && err.name === "RuleError" ? err.message : null;
  }
}

/** Rule names in the string that are not enforced (reported at import; skipped client-side). */
export function unsupportedRules(rules: string): string[] {
  return eggsUnsupportedRules(rules);
}

export type VariableInput =
  | { kind: "select"; options: string[]; optional: boolean }
  | { kind: "boolean" }
  | { kind: "number"; min?: number; max?: number; integer: boolean }
  | { kind: "text"; maxLength?: number };

/** The input that best fits a rule string (select for `in:`, switch for `boolean`, …). */
export function inputForRules(rules: string): VariableInput {
  const parsed = parseRules(rules);
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
