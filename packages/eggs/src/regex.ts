import { RE2JS } from "re2js";

/**
 * Linear-time regular expressions for untrusted patterns and inputs (egg `regex:` done lines,
 * `regex:` config conditions, Laravel `regex:` variable rules). JavaScript's backtracking RegExp is
 * never used on egg-authored patterns: a pattern such as `(a+)+$` would otherwise stall the
 * control-plane event loop. RE2 (re2js, a pure-JS port) guarantees time linear in the input and
 * rejects what it cannot do in linear time: backreferences, lookarounds, atomic groups and
 * possessive quantifiers. Inputs are additionally capped at `MAX_REGEX_INPUT` characters.
 */

export const MAX_REGEX_INPUT = 8 * 1024;

export class RegexUnsupportedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RegexUnsupportedError";
  }
}

export interface LinearRegex {
  readonly source: string;
  /** Unanchored search (like `RegExp#test`). Inputs longer than MAX_REGEX_INPUT never match. */
  test(input: string): boolean;
  /** Go `Regexp.ReplaceAllString` semantics (`$1`, `${1}`, `$name`, `${name}`, `$$`). */
  replaceAll(input: string, template: string): string;
}

export interface LinearFlags {
  ignoreCase?: boolean;
  multiline?: boolean;
  dotAll?: boolean;
}

function describe(e: unknown): string {
  const msg = e instanceof Error ? e.message : String(e);
  if (/\\[1-9]|backreference/i.test(msg)) return "backreferences are not supported (linear-time regex engine)";
  if (/\(\?[=!]|\(\?<[=!]|lookahead|lookbehind/i.test(msg)) return "lookarounds are not supported (linear-time regex engine)";
  if (/\(\?>/.test(msg)) return "atomic groups are not supported (linear-time regex engine)";
  if (/nested repetition|\*\+|\+\+|\?\+/.test(msg)) return "possessive quantifiers are not supported (linear-time regex engine)";
  return msg.replace(/^error parsing regexp: /, "");
}

/** Compiles an RE2-syntax pattern (Go `regexp`, which Wings uses for egg patterns). */
export function compileLinear(pattern: string, flags: LinearFlags = {}): LinearRegex {
  let f = 0;
  if (flags.ignoreCase) f |= RE2JS.CASE_INSENSITIVE;
  if (flags.multiline) f |= RE2JS.MULTILINE;
  if (flags.dotAll) f |= RE2JS.DOTALL;
  let re: RE2JS;
  try {
    re = RE2JS.compile(pattern, f);
  } catch (e) {
    throw new RegexUnsupportedError(describe(e));
  }
  return {
    source: pattern,
    test: (input) => input.length <= MAX_REGEX_INPUT && re.test(input),
    replaceAll: (input, template) => {
      if (input.length > MAX_REGEX_INPUT) return input;
      const m = re.matcher(input);
      let out = "";
      let last = 0;
      let pos = 0;
      while (pos <= input.length && m.find(pos)) {
        const start = m.start();
        const end = m.end();
        out += input.slice(last, start) + expandGoTemplate(template, (g) => m.group(g));
        last = end;
        pos = end === start ? end + 1 : end;
      }
      return out + input.slice(last);
    },
  };
}

/**
 * Go `regexp.Expand`: `$name` takes the longest run of letters/digits/underscores (so `$1x` is the
 * group named "1x"), `${name}` is explicit, `$$` is a literal `$`; unknown/unmatched groups expand
 * to "" and a `$` not followed by a name is kept.
 */
export function expandGoTemplate(template: string, group: (name: string | number) => string | null): string {
  let out = "";
  for (let i = 0; i < template.length; i++) {
    const c = template[i]!;
    if (c !== "$") {
      out += c;
      continue;
    }
    const next = template[i + 1];
    if (next === "$") {
      out += "$";
      i++;
      continue;
    }
    let name: string;
    let j = i + 1;
    if (next === "{") {
      const close = template.indexOf("}", i + 2);
      const inner = close === -1 ? "" : template.slice(i + 2, close);
      if (close === -1 || !/^\w+$/.test(inner)) {
        out += c;
        continue;
      }
      name = inner;
      j = close + 1;
    } else {
      while (j < template.length && /\w/.test(template[j]!)) j++;
      name = template.slice(i + 1, j);
      if (name === "") {
        out += c;
        continue;
      }
    }
    let v: string | null;
    try {
      v = group(/^\d+$/.test(name) ? Number(name) : name);
    } catch {
      v = null;
    }
    out += v ?? "";
    i = j - 1;
  }
  return out;
}

/**
 * Translates a PHP/PCRE pattern (`/…/flags`, also `#…#`, `~…~`, `{…}`) into RE2. `\A` and a final
 * `\Z` / `\z` become anchors; PCRE-only constructs raise RegexUnsupportedError.
 */
export function compilePcre(pattern: string): LinearRegex {
  if (pattern.length < 2) throw new RegexUnsupportedError("empty regex");
  const open = pattern[0]!;
  if (/[A-Za-z0-9\\\s]/.test(open)) throw new RegexUnsupportedError("regex needs a delimiter");
  const close = open === "(" ? ")" : open === "{" ? "}" : open === "[" ? "]" : open === "<" ? ">" : open;
  const end = pattern.lastIndexOf(close);
  if (end <= 0) throw new RegexUnsupportedError("regex is missing its closing delimiter");
  let body = pattern.slice(1, end);
  const flags = pattern.slice(end + 1);
  if (!/^[imsxuUDA]*$/.test(flags)) throw new RegexUnsupportedError(`unsupported regex flags "${flags}"`);
  if (/[xUA]/.test(flags)) throw new RegexUnsupportedError(`regex flag "${flags.replace(/[imsuD]/g, "")}" is not supported`);
  body = body.replace(/^\\A/, "^").replace(/\\[zZ]$/, "$");
  // An escaped delimiter (`\/`) is a plain character for RE2.
  if (open === "/") body = body.replace(/\\\//g, "/");
  return compileLinear(body, { ignoreCase: flags.includes("i"), multiline: flags.includes("m"), dotAll: flags.includes("s") });
}

/**
 * Removes ANSI/VT escape sequences in one pass (no regex): CSI (`ESC [` or `\x9b`, parameters,
 * intermediates, one final byte), OSC (`ESC ]` … BEL / `ESC \`) and two-byte escapes. Linear time.
 */
export function stripAnsiLinear(line: string): string {
  let out = "";
  const n = line.length;
  for (let i = 0; i < n; i++) {
    const c = line.charCodeAt(i);
    if (c !== 0x1b && c !== 0x9b) {
      out += line[i];
      continue;
    }
    let j = c === 0x9b ? i + 1 : i + 2;
    const kind = c === 0x9b ? "[" : line[i + 1];
    if (kind === "[") {
      while (j < n && line.charCodeAt(j) >= 0x30 && line.charCodeAt(j) <= 0x3f) j++; // parameters
      while (j < n && line.charCodeAt(j) >= 0x20 && line.charCodeAt(j) <= 0x2f) j++; // intermediates
      if (j < n && line.charCodeAt(j) >= 0x40 && line.charCodeAt(j) <= 0x7e) j++; // final byte
      i = j - 1;
    } else if (kind === "]") {
      while (j < n && line.charCodeAt(j) !== 0x07 && !(line.charCodeAt(j) === 0x1b && line[j + 1] === "\\")) j++;
      i = j < n && line.charCodeAt(j) === 0x1b ? j + 1 : j;
    } else if (kind === "(" || kind === ")" || kind === "#") {
      i = Math.min(n, i + 2); // ESC ( B — charset selection
    } else {
      i = kind === undefined ? i : i + 1; // ESC c, ESC 7 …
    }
  }
  return out;
}
