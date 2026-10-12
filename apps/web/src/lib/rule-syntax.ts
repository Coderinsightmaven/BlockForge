/*
 * Dependency-free reading of egg rule strings (Laravel syntax: `required|integer|between:1,255`,
 * `in:a,"b,c"`, `regex:/^(a|b)$/`). Mirrors `@blockforge/eggs` `parseRules` — pinned by a parity
 * test — so input pickers and cheap checks work without loading the full rule engine (which
 * carries a linear-time regex engine and is loaded lazily, see `variable-validation.ts`).
 */

export interface RuleToken {
  name: string;
  params: string[];
}

const ALIASES: Record<string, string> = { int: "integer", bool: "boolean" };

/** A `regex:` token is complete when its closing (unescaped) delimiter and flags are present. */
function regexComplete(token: string): boolean {
  const body = token.slice(token.indexOf(":") + 1);
  if (body.length < 2) return false;
  const d = body[0]!;
  const close = d === "(" ? ")" : d === "{" ? "}" : d === "[" ? "]" : d === "<" ? ">" : d;
  let end = body.length;
  while (end > 1 && /[a-zA-Z]/.test(body[end - 1]!)) end--;
  if (end <= 1 || body[end - 1] !== close) return false;
  let backslashes = 0;
  for (let i = end - 2; i >= 0 && body[i] === "\\"; i--) backslashes++;
  return backslashes % 2 === 0;
}

const REGEX_TOKEN = /^\s*(?:not_)?regex:/i;

/** Split on `|`, keeping `|` inside a `regex:` pattern that closes later. */
export function splitRuleString(rules: string): string[] {
  const tokens = rules.split("|");
  const out: string[] = [];
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i]!;
    if (REGEX_TOKEN.test(t) && !regexComplete(t.trim())) {
      let merged = t;
      let j = i;
      while (!regexComplete(merged.trim()) && j + 1 < tokens.length) merged += `|${tokens[++j]!}`;
      if (regexComplete(merged.trim())) {
        out.push(merged.trim());
        i = j;
        continue;
      }
      // Unclosed pattern: kept alone; the following rules stay separate.
      out.push(t.trim());
      continue;
    }
    if (t.trim() !== "") out.push(t.trim());
  }
  return out;
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
        if ((c === "\\" || c === '"') && s[i + 1] === '"') {
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
    }
    while (i < s.length && s[i] !== ",") field += s[i++];
    out.push(field.trim());
    if (i >= s.length) break;
    i++; // skip ","
  }
  return out;
}

export function parseRuleString(rules: string): RuleToken[] {
  return splitRuleString(rules).map((raw) => {
    const i = raw.indexOf(":");
    const lower = (i === -1 ? raw : raw.slice(0, i)).trim().toLowerCase();
    const name = ALIASES[lower] ?? lower;
    if (i === -1) return { name, params: [] };
    const rest = raw.slice(i + 1);
    return { name, params: name === "regex" || name === "not_regex" ? [rest] : parseCsvParams(rest) };
  });
}
