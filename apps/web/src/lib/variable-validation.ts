import { useEffect, useSyncExternalStore } from "react";
import type { TemplateVariable } from "@blockforge/contracts";
import type * as Eggs from "@blockforge/eggs";
import { parseRuleString } from "./rule-syntax";

/*
 * Egg variable validation in the browser. The full rule engine (`@blockforge/eggs`, the same code
 * the control plane runs) includes a linear-time regex engine, so it is loaded on first use
 * instead of with the wizard/startup page. Until it has loaded only cheap, certain checks run
 * (required, maximum length) — other rules show no error yet. Nothing waits for it: the server
 * validates every value authoritatively on submit.
 */

export type RuleVariable = Pick<TemplateVariable, "name" | "envName" | "rules">;

// Type-only (erased): the engine itself is only ever reached through the dynamic import below.
type RuleEngine = Pick<typeof Eggs, "validateVariableValue" | "unsupportedRules">;

let engine: RuleEngine | null = null;
let loading: Promise<RuleEngine> | null = null;
const listeners = new Set<() => void>();

/** Load the full rule engine once (memoised; a failed load can be retried). */
export function loadVariableRules(): Promise<RuleEngine> {
  // Destructured in the callback so the bundler keeps only these exports (and their
  // dependencies) in the lazy chunk, not the whole egg importer.
  loading ??= import("@blockforge/eggs").then(
    ({ validateVariableValue, unsupportedRules }) => {
      const loaded: RuleEngine = { validateVariableValue, unsupportedRules };
      engine = loaded;
      for (const l of [...listeners]) l();
      return loaded;
    },
    (err: unknown) => {
      loading = null;
      throw err;
    },
  );
  return loading;
}

export function variableRulesReady(): boolean {
  return engine !== null;
}

/** Checks that need no rule engine and match its verdicts and messages. */
export function cheapVariableCheck(variable: RuleVariable, value: string): string | null {
  const label = variable.name || variable.envName;
  const rules = parseRuleString(variable.rules);
  const names = new Set(rules.map((r) => r.name));
  if (value.trim() === "") return names.has("required") ? `${label} is required.` : null;
  if (names.has("integer") || names.has("numeric")) return null; // max is a numeric bound there
  const max = Number(rules.find((r) => r.name === "max")?.params[0]);
  if (Number.isFinite(max) && [...value].length > max) {
    return `${label} may not be greater than ${max} characters.`;
  }
  return null;
}

/** First error for `value`: the full rules once loaded, the cheap checks until then. */
export function validateVariable(variable: RuleVariable, value: string): string | null {
  if (!engine) return cheapVariableCheck(variable, value);
  try {
    return engine.validateVariableValue(variable, value);
  } catch (err) {
    // A rule the library cannot evaluate (e.g. an invalid regex): leave it to the server.
    return err instanceof Error && err.name === "RuleError" ? err.message : null;
  }
}

/** Rules in the string that are not enforced as written ([] until the engine has loaded). */
export function unsupportedVariableRules(rules: string): string[] {
  return engine ? engine.unsupportedRules(rules) : [];
}

function subscribe(cb: () => void): () => void {
  listeners.add(cb);
  return () => listeners.delete(cb);
}

/** Starts loading the engine on mount; re-renders once it is ready. */
export function useVariableValidation(): {
  validate: typeof validateVariable;
  unsupported: typeof unsupportedVariableRules;
  ready: boolean;
} {
  const ready = useSyncExternalStore(subscribe, variableRulesReady, variableRulesReady);
  useEffect(() => {
    // A failed chunk load (offline, new deploy) keeps the cheap checks; the server still validates.
    loadVariableRules().catch(() => {});
  }, []);
  return { validate: validateVariable, unsupported: unsupportedVariableRules, ready };
}
