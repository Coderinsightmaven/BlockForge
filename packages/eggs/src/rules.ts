import { SUPPORTED_VARIABLE_RULES, type TemplateVariable } from "@blockforge/contracts";

/**
 * Laravel validation rules as used by egg variables (Pterodactyl `VariableValidatorService`,
 * Pelican stores the same rules as an array). Semantics follow Laravel 10/11:
 *  - a value that is empty or whitespace-only only fails `required`; every other rule is skipped
 *    (Validator::presentOrRuleIsImplicit) — so `nullable` changes nothing for strings;
 *  - `min`/`max`/`between`/`size` compare numerically when the rule set contains `integer` or
 *    `numeric`, otherwise by character length (mb_strlen);
 *  - `boolean` accepts exactly "0" and "1" for string input (Laravel's strict in_array);
 *  - `integer` = PHP FILTER_VALIDATE_INT, `numeric` = PHP is_numeric (PHP 8);
 *  - `regex:` patterns are PCRE; the common subset is translated to JavaScript.
 * Rules outside SUPPORTED_VARIABLE_RULES are reported by `unsupportedRules` and not enforced.
 */

export interface ParsedRule {
  name: string;
  params: string[];
  raw: string;
}

const SUPPORTED = new Set<string>(SUPPORTED_VARIABLE_RULES);

/** True when a `regex:` rule token is complete (the closing delimiter and flags are present). */
function regexComplete(token: string): boolean {
  const body = token.slice(token.indexOf(":") + 1);
  if (body.length < 2) return false;
  const d = body[0]!;
  const close = d === "(" ? ")" : d === "{" ? "}" : d === "[" ? "]" : d === "<" ? ">" : d;
  const m = new RegExp(`\\${close}[a-zA-Z]*$`).exec(body);
  if (!m || m.index === 0) return false;
  // the closing delimiter must not be escaped
  let backslashes = 0;
  for (let i = m.index - 1; i >= 0 && body[i] === "\\"; i--) backslashes++;
  return backslashes % 2 === 0;
}

/** Splits a rule string on `|`, keeping `|` inside `regex:` patterns (as Pelican's array form allows). */
export function splitRules(rules: string | readonly string[]): string[] {
  if (Array.isArray(rules)) return rules.map((r) => String(r).trim()).filter((r) => r !== "");
  const tokens = String(rules).split("|");
  const out: string[] = [];
  for (let i = 0; i < tokens.length; i++) {
    let t = tokens[i]!;
    if (/^\s*(?:not_)?regex:/.test(t)) {
      while (!regexComplete(t.trim()) && i + 1 < tokens.length) t += `|${tokens[++i]!}`;
    }
    t = t.trim();
    if (t !== "") out.push(t);
  }
  return out;
}

export function parseRules(rules: string | readonly string[]): ParsedRule[] {
  return splitRules(rules).map((raw) => {
    const i = raw.indexOf(":");
    const name = (i === -1 ? raw : raw.slice(0, i)).trim().toLowerCase();
    if (i === -1) return { name, params: [], raw };
    const rest = raw.slice(i + 1);
    const params = name === "regex" || name === "not_regex" ? [rest] : rest.split(",").map((p) => p.trim());
    return { name, params, raw };
  });
}

/** Rule names in `rules` that BlockForge does not enforce. */
export function unsupportedRules(rules: string): string[] {
  const out: string[] = [];
  for (const r of parseRules(rules)) {
    if (!SUPPORTED.has(r.name)) out.push(r.name);
    else if (r.name === "regex") {
      try {
        pcreToRegExp(r.params[0] ?? "");
      } catch {
        out.push("regex");
      }
    }
  }
  return [...new Set(out)];
}

export class RuleError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RuleError";
  }
}

/** Translates a PHP/PCRE pattern (`/…/flags`, also `#…#`, `~…~`, `{…}`) into a JavaScript RegExp. */
export function pcreToRegExp(pattern: string): RegExp {
  if (pattern.length < 2) throw new RuleError("empty regex");
  const open = pattern[0]!;
  if (/[A-Za-z0-9\\\s]/.test(open)) throw new RuleError("regex needs a delimiter");
  const close = open === "(" ? ")" : open === "{" ? "}" : open === "[" ? "]" : open === "<" ? ">" : open;
  const end = pattern.lastIndexOf(close);
  if (end <= 0) throw new RuleError("regex is missing its closing delimiter");
  let body = pattern.slice(1, end);
  const flags = pattern.slice(end + 1);
  if (!/^[imsxuUDA]*$/.test(flags)) throw new RuleError(`unsupported regex flags "${flags}"`);
  if (/[xUA]/.test(flags)) throw new RuleError(`regex flag "${flags.replace(/[imsuD]/g, "")}" is not supported`);
  // \A / \z / \Z at the ends map to ^ / $; anything else PCRE-only is rejected (possessive and
  // atomic groups, \G \K \R, recursion, conditionals, inline comments).
  body = body.replace(/^\\A/, "^").replace(/\\[zZ]$/, "$");
  if (/\(\?>|\*\+|\+\+|\?\+|\}\+|\\[AzZGKR]|\(\?R\)|\(\?\d|\(\?[+-]\d|\(\?&|\(\?P>|\(\?\(|\(\?#/.test(body)) {
    throw new RuleError("regex uses PCRE-only syntax");
  }
  body = body.replace(/\(\?P<([A-Za-z_][A-Za-z0-9_]*)>/g, "(?<$1>").replace(/\(\?P=([A-Za-z_][A-Za-z0-9_]*)\)/g, "\\k<$1>");
  let jsFlags = "";
  if (flags.includes("i")) jsFlags += "i";
  if (flags.includes("m")) jsFlags += "m";
  if (flags.includes("s")) jsFlags += "s";
  if (flags.includes("u") || /\\p\{|\\P\{|\\X/.test(body)) jsFlags += "u";
  // PCRE `$` also matches before a final newline unless D is set; JS never does. Values are
  // single-line in practice, so the difference is ignored.
  try {
    return new RegExp(body, jsFlags);
  } catch (e) {
    throw new RuleError(`invalid regex: ${(e as Error).message}`);
  }
}

const INT64_MIN = -(2n ** 63n);
const INT64_MAX = 2n ** 63n - 1n;

function isPhpInt(v: string): boolean {
  const t = v.trim();
  if (!/^[+-]?(?:0|[1-9]\d*)$/.test(t)) return false;
  const n = BigInt(t);
  return n >= INT64_MIN && n <= INT64_MAX;
}

function isPhpNumeric(v: string): boolean {
  return /^\s*[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?\s*$/.test(v);
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
 * Rules BlockForge does not support are skipped (they were reported at import).
 */
export function validateVariableValue(variable: Pick<TemplateVariable, "name" | "envName" | "rules">, value: string): string | null {
  const label = variable.name || variable.envName;
  const rules = parseRules(variable.rules);
  const names = new Set(rules.map((r) => r.name));
  const numericContext = names.has("integer") || names.has("numeric");
  const length = [...value].length;
  if (value.trim() === "") {
    return names.has("required") ? `${label} is required.` : null;
  }
  const size = (rule: string): number => {
    if (numericContext) {
      if (!isPhpNumeric(value)) throw new RuleError(`${label} must be a number.`);
      return Number(value.trim());
    }
    void rule;
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
          if (!isPhpInt(value)) return `${label} must be an integer.`;
          break;
        case "numeric":
          if (!isPhpNumeric(value)) return `${label} must be a number.`;
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
          if (size("min") < m) return `${label} must be at least ${m}${unit}.`;
          break;
        }
        case "max": {
          const m = num(p[0], "max");
          if (size("max") > m) return `${label} may not be greater than ${m}${unit}.`;
          break;
        }
        case "between": {
          const lo = num(p[0], "between");
          const hi = num(p[1], "between");
          const s = size("between");
          if (s < lo || s > hi) return `${label} must be between ${lo} and ${hi}${unit}.`;
          break;
        }
        case "size": {
          const m = num(p[0], "size");
          if (size("size") !== m) return `${label} must be ${m}${unit}.`;
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
          let re: RegExp;
          try {
            re = pcreToRegExp(p[0] ?? "");
          } catch {
            break; // reported as unsupported at import
          }
          if (!re.test(value)) return `${label} has an invalid format.`;
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
