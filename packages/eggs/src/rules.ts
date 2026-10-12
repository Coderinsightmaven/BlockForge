import { SUPPORTED_VARIABLE_RULES, type TemplateVariable } from "@blockforge/contracts";
import { MAX_REGEX_INPUT, type LinearRegex, RegexUnsupportedError, compilePcre } from "./regex.js";

/**
 * Laravel validation rules as used by egg variables (Pterodactyl `VariableValidatorService`,
 * Pelican stores the same rules as an array).
 *  - Only the empty string is "empty": it fails `required`; with `nullable` every other rule is
 *    skipped; without `nullable` the other rules are evaluated against "" (Laravel converts empty
 *    input to null, which `nullable` alone lets through). Whitespace-only values fail `required`
 *    and are otherwise validated like any other value.
 *  - `min`/`max`/`between`/`size` compare numerically when the rule set contains `integer`/`int`
 *    or `numeric`, otherwise by character length (mb_strlen).
 *  - Aliases used by real eggs: `int` → `integer`, `bool` → `boolean`.
 *  - `boolean` accepts exactly "0" and "1" for string input (Laravel's strict in_array).
 *  - `integer`: optional sign + digits (leading zeros allowed, surrounding whitespace not — stricter
 *    than PHP's FILTER_VALIDATE_INT about spaces, which matter in startup commands), 64-bit range;
 *    `numeric`: decimal/exponent notation without surrounding whitespace.
 *  - Rule parameters are parsed as CSV (`in:"a,b",c`), then trimmed.
 *  - `regex:` patterns are PCRE, translated to RE2 (linear time). Patterns RE2 cannot express
 *    (backreferences, lookarounds, …) and unclosed patterns fail closed: every non-empty value is
 *    rejected, and the import reports them.
 * Other rules outside SUPPORTED_VARIABLE_RULES are reported by `unsupportedRules` and not enforced.
 */

export interface ParsedRule {
  name: string;
  params: string[];
  raw: string;
  /** `regex:` token whose closing delimiter is missing (fails closed). */
  unclosed?: boolean;
}

const SUPPORTED = new Set<string>(SUPPORTED_VARIABLE_RULES);
const ALIASES: Record<string, string> = { int: "integer", bool: "boolean" };

/** True when a `regex:` rule token is complete (the closing delimiter and flags are present). */
function regexComplete(token: string): boolean {
  const body = token.slice(token.indexOf(":") + 1);
  if (body.length < 2) return false;
  const d = body[0]!;
  const close = d === "(" ? ")" : d === "{" ? "}" : d === "[" ? "]" : d === "<" ? ">" : d;
  let end = body.length;
  while (end > 1 && /[a-zA-Z]/.test(body[end - 1]!)) end--;
  if (end <= 1 || body[end - 1] !== close) return false;
  // the closing delimiter must not be escaped
  let backslashes = 0;
  for (let i = end - 2; i >= 0 && body[i] === "\\"; i--) backslashes++;
  return backslashes % 2 === 0;
}

export interface SplitRule {
  raw: string;
  unclosed: boolean;
  /** For unclosed regexes: the rule tokens that follow it (kept as separate rules). */
  following?: string[];
}

/**
 * Splits a rule string on `|`, keeping `|` inside a `regex:` pattern when the pattern closes
 * later (`regex:/^(a|b)$/`). A pattern that never closes does not swallow the following rules: it
 * is kept alone and marked unclosed.
 */
export function splitRulesDetailed(rules: string | readonly string[]): SplitRule[] {
  if (Array.isArray(rules)) {
    return rules
      .map((r) => String(r).trim())
      .filter((r) => r !== "")
      .map((raw) => ({ raw, unclosed: /^(?:not_)?regex:/i.test(raw) && !regexComplete(raw) }));
  }
  const tokens = String(rules).split("|");
  const out: SplitRule[] = [];
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i]!;
    if (/^\s*(?:not_)?regex:/i.test(t) && !regexComplete(t.trim())) {
      let merged = t;
      let j = i;
      while (!regexComplete(merged.trim()) && j + 1 < tokens.length) merged += `|${tokens[++j]!}`;
      if (regexComplete(merged.trim())) {
        out.push({ raw: merged.trim(), unclosed: false });
        i = j;
        continue;
      }
      out.push({ raw: t.trim(), unclosed: true, following: tokens.slice(i + 1).map((x) => x.trim()).filter((x) => x !== "") });
      continue;
    }
    if (t.trim() !== "") out.push({ raw: t.trim(), unclosed: false });
  }
  return out;
}

export function splitRules(rules: string | readonly string[]): string[] {
  return splitRulesDetailed(rules).map((r) => r.raw);
}

/** PHP `str_getcsv` (`,` separator, `"` enclosure, `""` or `\"` escapes), each field trimmed. */
export function parseCsvParams(s: string): string[] {
  const out: string[] = [];
  let i = 0;
  for (;;) {
    while (s[i] === " " || s[i] === "\t") i++;
    let field = "";
    if (s[i] === '"') {
      i++;
      for (;;) {
        const c = s[i];
        if (c === undefined) break;
        if (c === "\\" && s[i + 1] === '"') {
          field += '"';
          i += 2;
        } else if (c === '"' && s[i + 1] === '"') {
          field += '"';
          i += 2;
        } else if (c === '"') {
          i++;
          break;
        } else {
          field += c;
          i++;
        }
      }
      while (i < s.length && s[i] !== ",") field += s[i++];
    } else {
      while (i < s.length && s[i] !== ",") field += s[i++];
    }
    out.push(field.trim());
    if (i >= s.length) break;
    i++; // skip ","
  }
  return out;
}

export function parseRules(rules: string | readonly string[]): ParsedRule[] {
  return splitRulesDetailed(rules).map(({ raw, unclosed }) => {
    const i = raw.indexOf(":");
    const lower = (i === -1 ? raw : raw.slice(0, i)).trim().toLowerCase();
    const name = ALIASES[lower] ?? lower;
    if (i === -1) return { name, params: [], raw };
    const rest = raw.slice(i + 1);
    const params = name === "regex" || name === "not_regex" ? [rest] : parseCsvParams(rest);
    return unclosed ? { name, params, raw, unclosed: true } : { name, params, raw };
  });
}

export class RuleError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RuleError";
  }
}

/** Translates a PHP/PCRE `regex:` pattern to a linear-time matcher; throws RuleError when impossible. */
export function compileRuleRegex(pattern: string): LinearRegex {
  try {
    return compilePcre(pattern);
  } catch (e) {
    if (e instanceof RegexUnsupportedError) throw new RuleError(e.message);
    throw e;
  }
}

/** @deprecated kept for API compatibility; returns an RE2-backed matcher with `test`. */
export const pcreToRegExp = compileRuleRegex;

export interface RuleProblem {
  rule: string;
  message: string;
}

/** Problems with a rule string for the import report (unsupported names, unusable regexes). */
export function ruleProblems(rules: string): RuleProblem[] {
  const out: RuleProblem[] = [];
  const split = splitRulesDetailed(rules);
  for (const r of parseRules(rules)) {
    if (r.name === "regex") {
      if (r.unclosed) {
        const following = split.find((s) => s.raw === r.raw && s.unclosed)?.following ?? [];
        const names = following.map((f) => f.split(":")[0]!.trim()).filter((x) => x !== "");
        out.push({
          rule: "regex",
          message: `regex rule "${r.raw}" is not closed; it rejects every value${names.length > 0 ? ` (the following rule${names.length > 1 ? "s" : ""} ${names.join(", ")} would have been swallowed and are kept as separate rules)` : ""}`,
        });
        continue;
      }
      try {
        compileRuleRegex(r.params[0] ?? "");
      } catch (e) {
        out.push({ rule: "regex", message: `regex rule "${r.raw}" cannot be enforced (${(e as Error).message}); it rejects every value` });
      }
      continue;
    }
    if (!SUPPORTED.has(r.name)) out.push({ rule: r.name, message: `rule ${r.name} is not enforced` });
  }
  return out;
}

/** Rule names in `rules` that BlockForge does not enforce as written (regex problems included). */
export function unsupportedRules(rules: string): string[] {
  return [...new Set(ruleProblems(rules).map((p) => p.rule))];
}

const INT64_MIN = -(2n ** 63n);
const INT64_MAX = 2n ** 63n - 1n;

function isInt(v: string): boolean {
  if (!/^[+-]?\d+$/.test(v)) return false;
  const n = BigInt(v);
  return n >= INT64_MIN && n <= INT64_MAX;
}

function isNumeric(v: string): boolean {
  return /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/.test(v);
}

function isIp(v: string): boolean {
  if (/^(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(?:\.(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)){3}$/.test(v)) return true;
  if (!v.includes(":") || !/^[0-9a-fA-F:.]+$/.test(v)) return false;
  try {
    return new URL(`http://[${v}]/`).hostname.length > 2;
  } catch {
    return false;
  }
}

function isUrl(v: string): boolean {
  if (/\s/.test(v)) return false;
  let u: URL;
  try {
    u = new URL(v);
  } catch {
    return false;
  }
  const schemes = ["http:", "https:", "ftp:", "ftps:", "ssh:", "sftp:", "ws:", "wss:", "git:", "file:", "mailto:", "steam:", "irc:", "ircs:", "udp:", "tcp:", "redis:", "mysql:", "postgres:", "postgresql:", "mongodb:", "s3:", "magnet:", "minecraft:"];
  if (!schemes.includes(u.protocol)) return false;
  return u.protocol === "mailto:" || u.protocol === "magnet:" || u.protocol === "file:" || u.hostname !== "";
}

const ALPHA = /^[\p{L}\p{M}]+$/u;
const ALPHA_NUM = /^[\p{L}\p{M}\p{N}]+$/u;
const ALPHA_DASH = /^[\p{L}\p{M}\p{N}_-]+$/u;

function num(p: string | undefined, rule: string): number {
  const n = Number(p);
  if (p === undefined || p.trim() === "" || !Number.isFinite(n)) throw new RuleError(`rule ${rule} needs a numeric parameter`);
  return n;
}

/**
 * Validates a value against the variable's rules. Returns an error message or `null`.
 * Rules BlockForge does not support are skipped (they were reported at import); regex rules that
 * cannot be enforced reject every non-empty value.
 */
export function validateVariableValue(variable: Pick<TemplateVariable, "name" | "envName" | "rules">, value: string): string | null {
  const label = variable.name || variable.envName;
  const rules = parseRules(variable.rules);
  const names = new Set(rules.map((r) => r.name));
  const numericContext = names.has("integer") || names.has("numeric");
  const length = [...value].length;
  if (value === "" || value.trim() === "") {
    if (names.has("required")) return `${label} is required.`;
    if (value === "" && names.has("nullable")) return null;
  }
  const size = (): number => {
    if (numericContext) {
      if (!isNumeric(value)) throw new RuleError(`${label} must be a number.`);
      return Number(value);
    }
    return length;
  };
  const unit = numericContext ? "" : " characters";
  try {
    for (const r of rules) {
      const p = r.params;
      switch (r.name) {
        case "required":
        case "nullable":
        case "sometimes":
        case "string":
          break;
        case "integer":
          if (!isInt(value)) return `${label} must be an integer.`;
          break;
        case "numeric":
          if (!isNumeric(value)) return `${label} must be a number.`;
          break;
        case "boolean":
          if (value !== "0" && value !== "1") return `${label} must be 0 or 1.`;
          break;
        case "alpha":
          if (!ALPHA.test(value)) return `${label} may only contain letters.`;
          break;
        case "alpha_num":
          if (!ALPHA_NUM.test(value)) return `${label} may only contain letters and numbers.`;
          break;
        case "alpha_dash":
          if (!ALPHA_DASH.test(value)) return `${label} may only contain letters, numbers, dashes and underscores.`;
          break;
        case "url":
          if (!isUrl(value)) return `${label} must be a valid URL.`;
          break;
        case "ip":
          if (!isIp(value)) return `${label} must be a valid IP address.`;
          break;
        case "in":
          if (!p.includes(value)) return `${label} must be one of: ${p.join(", ")}.`;
          break;
        case "not_in":
          if (p.includes(value)) return `${label} must not be one of: ${p.join(", ")}.`;
          break;
        case "min": {
          const m = num(p[0], "min");
          if (size() < m) return `${label} must be at least ${m}${unit}.`;
          break;
        }
        case "max": {
          const m = num(p[0], "max");
          if (size() > m) return `${label} may not be greater than ${m}${unit}.`;
          break;
        }
        case "between": {
          const lo = num(p[0], "between");
          const hi = num(p[1], "between");
          const s = size();
          if (s < lo || s > hi) return `${label} must be between ${lo} and ${hi}${unit}.`;
          break;
        }
        case "size": {
          const m = num(p[0], "size");
          if (size() !== m) return `${label} must be ${m}${unit}.`;
          break;
        }
        case "digits": {
          const d = num(p[0], "digits");
          if (!/^\d+$/.test(value) || value.length !== d) return `${label} must be ${d} digits.`;
          break;
        }
        case "digits_between": {
          const lo = num(p[0], "digits_between");
          const hi = num(p[1], "digits_between");
          if (!/^\d+$/.test(value) || value.length < lo || value.length > hi) return `${label} must be between ${lo} and ${hi} digits.`;
          break;
        }
        case "regex": {
          if (r.unclosed) return `${label} cannot be validated: its regex rule is not closed.`;
          let re: LinearRegex;
          try {
            re = compileRuleRegex(p[0] ?? "");
          } catch {
            return `${label} cannot be validated: its regex rule is not supported.`;
          }
          if (value.length > MAX_REGEX_INPUT || !re.test(value)) return `${label} has an invalid format.`;
          break;
        }
        default:
          break; // unsupported: reported at import, not enforced
      }
    }
  } catch (e) {
    if (e instanceof RuleError) return e.message;
    throw e;
  }
  return null;
}
