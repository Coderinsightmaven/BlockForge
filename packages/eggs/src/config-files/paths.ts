/**
 * Wings' JSON/YAML replacement semantics (wings/parser/helpers.go `IterateOverJson`,
 * `SetAtPathway`, `setValueAtPath`, `getKeyValue`), applied to plain JS data:
 *  - paths are dotted (`a.b.c`), with `[n]` array indices (`listeners[0].host`) and `*`
 *    wildcards over the children of a mapping or list (`servers.*.address`);
 *  - without `if_value` the value is set, creating missing mappings (and `[0]` of a missing list);
 *  - `if_value: "regex:<expr>"` requires an existing value matching expr and replaces with
 *    `value.replace(expr, replacement)` (`$1` groups, result stays a string);
 *  - any other `if_value` sets the value only when the current value equals it (Wings also writes
 *    when the path is missing; BlockForge applies conditional entries only on a match);
 *  - values that parse as an integer (Go `strconv.Atoi`) are written as numbers, others as strings.
 * The changed concrete paths are recorded so source-preserving writers can replay them.
 */

export type Seg = string | number;
export type Path = Seg[];

export interface Replacement {
  match: string;
  ifValue: string | null;
  replaceWith: string;
}

export interface PathEdit {
  path: Path;
  value: string | number;
}

export class PathSyntaxError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PathSyntaxError";
  }
}

/** `listeners[0].query_port` → ["listeners", 0, "query_port"]; `servers.*.address` keeps "*". */
export function parsePath(match: string): Path {
  const out: Path = [];
  for (const part of match.split(".")) {
    const m = /^([^[\]]*)((?:\[\d+\])*)$/.exec(part);
    if (!m) throw new PathSyntaxError(`invalid path segment "${part}" in "${match}"`);
    if (m[1] !== "") out.push(m[1]!);
    else if (m[2] === "") throw new PathSyntaxError(`empty path segment in "${match}"`);
    for (const idx of m[2]!.matchAll(/\[(\d+)\]/g)) out.push(Number(idx[1]));
  }
  if (out.length === 0) throw new PathSyntaxError("empty path");
  return out;
}

/** Go strconv.Atoi on 64-bit (kept as a string beyond JS's safe integer range). */
export function typedValue(value: string): string | number {
  if (!/^[+-]?\d+$/.test(value)) return value;
  const n = Number(value);
  return Number.isSafeInteger(n) ? n : value;
}

type Container = Record<string, unknown> | unknown[];

function isObj(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** Text form used for if_value comparisons (Wings `valueAtPath`). */
export function textOf(v: unknown): string {
  if (typeof v === "string") return v;
  return JSON.stringify(v) ?? "null";
}

function getAt(root: unknown, path: Path): { found: boolean; value: unknown } {
  let cur: unknown = root;
  for (const seg of path) {
    if (typeof seg === "number") {
      if (!Array.isArray(cur) || seg >= cur.length) return { found: false, value: undefined };
      cur = cur[seg];
    } else {
      if (!isObj(cur) || !Object.prototype.hasOwnProperty.call(cur, seg)) return { found: false, value: undefined };
      cur = cur[seg];
    }
  }
  return { found: true, value: cur };
}

/** Sets a value creating missing mappings; returns false (with a reason) when impossible. */
function setAt(root: Container, path: Path, value: unknown): string | null {
  let cur: unknown = root;
  for (let i = 0; i < path.length; i++) {
    const seg = path[i]!;
    const last = i === path.length - 1;
    const nextSeg = path[i + 1];
    if (typeof seg === "number") {
      if (!Array.isArray(cur)) return `"${path.slice(0, i).join(".")}" is not a list`;
      if (seg > cur.length || (seg === cur.length && seg !== 0)) return `list index ${seg} does not exist`;
      if (last) {
        cur[seg] = value;
        return null;
      }
      if (cur[seg] === undefined || cur[seg] === null) cur[seg] = typeof nextSeg === "number" ? [] : {};
      cur = cur[seg];
      continue;
    }
    if (!isObj(cur)) return `"${path.slice(0, i).join(".") || "(root)"}" is not a mapping`;
    if (last) {
      cur[seg] = value;
      return null;
    }
    const child = cur[seg];
    if (child === undefined || child === null) {
      cur[seg] = typeof nextSeg === "number" ? [] : {};
    } else if (typeof child !== "object") {
      return `"${path.slice(0, i + 1).join(".")}" is a scalar, cannot set "${path.join(".")}"`;
    }
    cur = cur[seg];
  }
  return null;
}

/** Expands `*` segments against the current data. */
export function expandWildcards(root: unknown, path: Path): Path[] {
  const star = path.indexOf("*");
  if (star === -1) return [path];
  const prefix = path.slice(0, star);
  const rest = path.slice(star + 1);
  const { found, value } = getAt(root, prefix);
  if (!found || value === null || typeof value !== "object") return [];
  const keys: Seg[] = Array.isArray(value) ? value.map((_, i) => i) : Object.keys(value);
  return keys.flatMap((k) => expandWildcards(root, [...prefix, k, ...rest]));
}

/** Converts a Go RE2 replacement regex to JS (named groups) — `$n` works in both. */
function goRegex(expr: string): RegExp {
  return new RegExp(expr.replace(/\(\?P<([A-Za-z_][A-Za-z0-9_]*)>/g, "(?<$1>"), "g");
}

/**
 * Applies replacements to `root` in order (mutating it) and returns the concrete edits plus
 * warnings. The value written is `typedValue(replaceWith)` except for regex replacements.
 */
export function applyReplacements(root: Container, replacements: readonly Replacement[]): { edits: PathEdit[]; warnings: string[] } {
  const edits: PathEdit[] = [];
  const warnings: string[] = [];
  for (const r of replacements) {
    let pattern: Path;
    try {
      pattern = parsePath(r.match);
    } catch (e) {
      warnings.push((e as Error).message);
      continue;
    }
    const wildcard = pattern.includes("*");
    for (const path of expandWildcards(root, pattern)) {
      const cur = getAt(root, path);
      let value: string | number;
      if (r.ifValue !== null && r.ifValue.startsWith("regex:")) {
        if (!cur.found) continue;
        let re: RegExp;
        try {
          re = goRegex(r.ifValue.slice(6));
        } catch {
          warnings.push(`invalid regex in "${r.match}" condition; replacement skipped`);
          continue;
        }
        const text = textOf(cur.value);
        re.lastIndex = 0;
        if (!re.test(text)) continue;
        re.lastIndex = 0;
        value = text.replace(re, r.replaceWith);
      } else {
        // Stricter than Wings (which also writes when the path is missing): a conditional
        // replacement only applies when the current value matches.
        if (r.ifValue !== null && (!cur.found || textOf(cur.value) !== r.ifValue)) continue;
        value = typedValue(r.replaceWith);
      }
      if (cur.found && cur.value === value) continue;
      if (wildcard && !cur.found && path.length > 1) {
        // Wings creates the key inside each wildcard child that is a mapping
        const parent = getAt(root, path.slice(0, -1));
        if (!isObj(parent.value)) continue;
      }
      const err = setAt(root, path, value);
      if (err) {
        warnings.push(`cannot set "${r.match}": ${err}`);
        continue;
      }
      edits.push({ path, value });
    }
  }
  return { edits, warnings };
}
