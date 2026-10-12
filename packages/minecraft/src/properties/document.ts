/**
 * Format-preserving editor for Java `.properties` files (server.properties, eula.txt).
 *
 * Semantics follow `java.util.Properties#load(Reader)`:
 *  - natural lines end with `\n`, `\r\n` or `\r`; a line ending in an odd number of backslashes
 *    continues on the next natural line, whose leading whitespace is dropped;
 *  - leading whitespace (space, tab, form feed) is ignored; lines whose first non-blank char is
 *    `#` or `!` are comments (comments never continue);
 *  - the key ends at the first unescaped `=`, `:` or whitespace; then optional whitespace, one
 *    optional `=`/`:` and more whitespace separate it from the value;
 *  - escapes: `\t \n \r \f`, `\uXXXX`, and `\x` → `x` for any other char (`\:`, `\=`, `\\`, `\ `);
 *  - the last occurrence of a duplicated key wins.
 * Untouched lines (including their line terminators) are reproduced byte-for-byte.
 * Writing follows `Properties#store(Writer)` escaping (Minecraft writes UTF-8 without `\u`
 * escapes for non-ASCII; control characters are always `\u`-escaped here).
 */

export type Eol = "\n" | "\r\n" | "\r" | "";

export interface RawLine {
  text: string;
  eol: Eol;
}

export type PropertiesLine =
  | { kind: "blank"; raw: RawLine[] }
  | { kind: "comment"; raw: RawLine[] }
  | {
      kind: "entry";
      key: string;
      value: string;
      raw: RawLine[];
      /** Text before the value on the first natural line (indent + raw key + separator) when the value starts on it. */
      prefix: string | null;
    };

export interface PropertiesDocument {
  readonly lines: readonly PropertiesLine[];
  /** Terminator used for appended lines (dominant terminator of the input, default `\n`). */
  readonly eol: Exclude<Eol, "">;
}

export class PropertiesSyntaxError extends Error {
  readonly line: number;
  constructor(message: string, line: number) {
    super(`${message} (line ${line})`);
    this.name = "PropertiesSyntaxError";
    this.line = line;
  }
}

function splitNaturalLines(text: string): RawLine[] {
  const out: RawLine[] = [];
  let start = 0;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === "\n") {
      out.push({ text: text.slice(start, i), eol: "\n" });
      start = i + 1;
    } else if (c === "\r") {
      if (text[i + 1] === "\n") {
        out.push({ text: text.slice(start, i), eol: "\r\n" });
        i++;
      } else {
        out.push({ text: text.slice(start, i), eol: "\r" });
      }
      start = i + 1;
    }
  }
  if (start < text.length) out.push({ text: text.slice(start), eol: "" });
  return out;
}

const WS = new Set([" ", "\t", "\f"]);

function skipWs(s: string, i: number): number {
  while (i < s.length && WS.has(s[i]!)) i++;
  return i;
}

function endsWithOddBackslashes(s: string): boolean {
  let n = 0;
  for (let i = s.length - 1; i >= 0 && s[i] === "\\"; i--) n++;
  return n % 2 === 1;
}

/** Decodes Java properties escapes. */
export function unescapeProperties(s: string, lineNo = 0): string {
  let out = "";
  for (let i = 0; i < s.length; i++) {
    const c = s[i]!;
    if (c !== "\\") {
      out += c;
      continue;
    }
    const n = s[++i];
    if (n === undefined) break; // dangling backslash at end of input is dropped (as Java does)
    switch (n) {
      case "t":
        out += "\t";
        break;
      case "n":
        out += "\n";
        break;
      case "r":
        out += "\r";
        break;
      case "f":
        out += "\f";
        break;
      case "u": {
        const hex = s.slice(i + 1, i + 5);
        if (!/^[0-9a-fA-F]{4}$/.test(hex)) throw new PropertiesSyntaxError("Malformed \\uxxxx encoding", lineNo);
        out += String.fromCharCode(parseInt(hex, 16));
        i += 4;
        break;
      }
      default:
        out += n;
    }
  }
  return out;
}

function escapeChars(s: string, isKey: boolean, asciiOnly: boolean): string {
  let out = "";
  for (let i = 0; i < s.length; i++) {
    const c = s[i]!;
    const code = c.charCodeAt(0);
    switch (c) {
      case "\\":
        out += "\\\\";
        continue;
      case "\t":
        out += "\\t";
        continue;
      case "\n":
        out += "\\n";
        continue;
      case "\r":
        out += "\\r";
        continue;
      case "\f":
        out += "\\f";
        continue;
      case "=":
      case ":":
      case "#":
      case "!":
        out += `\\${c}`;
        continue;
      case " ":
        out += isKey || i === 0 ? "\\ " : " ";
        continue;
    }
    if (code < 0x20 || code === 0x7f || (asciiOnly && code > 0x7e)) {
      out += `\\u${code.toString(16).toUpperCase().padStart(4, "0")}`;
    } else {
      out += c;
    }
  }
  return out;
}

export function escapePropertyKey(key: string, opts: { asciiOnly?: boolean } = {}): string {
  return escapeChars(key, true, opts.asciiOnly ?? false);
}

export function escapePropertyValue(value: string, opts: { asciiOnly?: boolean } = {}): string {
  return escapeChars(value, false, opts.asciiOnly ?? false);
}

/** Splits a logical line into raw key / separator / raw value (no unescaping). */
function splitKeyValue(logical: string): { rawKey: string; sepEnd: number } {
  let i = 0;
  let escaped = false;
  for (; i < logical.length; i++) {
    const c = logical[i]!;
    if (escaped) {
      escaped = false;
      continue;
    }
    if (c === "\\") {
      escaped = true;
      continue;
    }
    if (c === "=" || c === ":" || WS.has(c)) break;
  }
  const rawKey = logical.slice(0, i);
  let j = skipWs(logical, i);
  if (j < logical.length && (logical[j] === "=" || logical[j] === ":")) j = skipWs(logical, j + 1);
  return { rawKey, sepEnd: j };
}

export function parseProperties(text: string): PropertiesDocument {
  const natural = splitNaturalLines(text);
  const lines: PropertiesLine[] = [];
  const counts = { "\n": 0, "\r\n": 0, "\r": 0 };
  for (const l of natural) if (l.eol !== "") counts[l.eol]++;
  const eol: PropertiesDocument["eol"] =
    counts["\r\n"] > counts["\n"] && counts["\r\n"] >= counts["\r"] ? "\r\n" : counts["\r"] > counts["\n"] ? "\r" : "\n";

  for (let idx = 0; idx < natural.length; idx++) {
    const first = natural[idx]!;
    const lineNo = idx + 1;
    const start = skipWs(first.text, 0);
    if (start === first.text.length) {
      lines.push({ kind: "blank", raw: [first] });
      continue;
    }
    const lead = first.text[start];
    if (lead === "#" || lead === "!") {
      lines.push({ kind: "comment", raw: [first] });
      continue;
    }
    const raw: RawLine[] = [first];
    let logical = first.text.slice(start);
    while (endsWithOddBackslashes(logical)) {
      logical = logical.slice(0, -1);
      const next = natural[idx + 1];
      if (!next) break;
      idx++;
      raw.push(next);
      logical += next.text.slice(skipWs(next.text, 0));
    }
    const { rawKey, sepEnd } = splitKeyValue(logical);
    const key = unescapeProperties(rawKey, lineNo);
    const value = unescapeProperties(logical.slice(sepEnd), lineNo);
    // The prefix can be reused only when key + separator lie entirely on the first natural line.
    const firstContent = first.text.slice(start);
    const prefixFitsFirstLine = raw.length === 1 || sepEnd <= firstContent.length - (endsWithOddBackslashes(firstContent) ? 1 : 0);
    lines.push({ kind: "entry", key, value, raw, prefix: prefixFitsFirstLine ? first.text.slice(0, start + sepEnd) : null });
  }
  return { lines, eol };
}

export function serializeProperties(doc: PropertiesDocument): string {
  let out = "";
  for (const l of doc.lines) for (const r of l.raw) out += r.text + r.eol;
  return out;
}

/** All key/value pairs; the last occurrence of a duplicated key wins (Java semantics). */
export function getProperties(doc: PropertiesDocument): Record<string, string> {
  const out: Record<string, string> = Object.create(null) as Record<string, string>;
  for (const l of doc.lines) if (l.kind === "entry") out[l.key] = l.value;
  return { ...out };
}

export function getProperty(doc: PropertiesDocument, key: string): string | undefined {
  for (let i = doc.lines.length - 1; i >= 0; i--) {
    const l = doc.lines[i]!;
    if (l.kind === "entry" && l.key === key) return l.value;
  }
  return undefined;
}

/** Keys that occur more than once (earlier occurrences are shadowed). */
export function duplicateKeys(doc: PropertiesDocument): string[] {
  const seen = new Map<string, number>();
  for (const l of doc.lines) if (l.kind === "entry") seen.set(l.key, (seen.get(l.key) ?? 0) + 1);
  return [...seen].filter(([, n]) => n > 1).map(([k]) => k);
}

export type PropertyValue = string | number | boolean | null;

export function stringifyPropertyValue(v: Exclude<PropertyValue, null>): string {
  if (typeof v === "number") {
    if (!Number.isFinite(v)) throw new RangeError("property values must be finite numbers");
    return String(v);
  }
  return String(v);
}

/**
 * Returns a new document with the given keys set (`null` removes every occurrence). Existing
 * entries keep their position, indentation, key spelling and separator; entries whose decoded
 * value is unchanged are left byte-for-byte untouched. New keys are appended at the end.
 */
export function setProperties(
  doc: PropertiesDocument,
  values: Readonly<Record<string, PropertyValue>>,
  opts: { asciiOnly?: boolean } = {},
): PropertiesDocument {
  const lines = [...doc.lines];
  for (const [key, v] of Object.entries(values)) {
    if (key.length === 0) throw new RangeError("property keys must not be empty");
    if (v === null) {
      for (let i = lines.length - 1; i >= 0; i--) {
        const l = lines[i]!;
        if (l.kind === "entry" && l.key === key) lines.splice(i, 1);
      }
      continue;
    }
    const value = stringifyPropertyValue(v);
    let idx = -1;
    for (let i = lines.length - 1; i >= 0; i--) {
      const l = lines[i]!;
      if (l.kind === "entry" && l.key === key) {
        idx = i;
        break;
      }
    }
    const escapedValue = escapePropertyValue(value, opts);
    if (idx >= 0) {
      const old = lines[idx]! as Extract<PropertiesLine, { kind: "entry" }>;
      if (old.value === value) continue;
      const prefix = old.prefix ?? `${escapePropertyKey(key, opts)}=`;
      const lastEol = old.raw[old.raw.length - 1]!.eol;
      lines[idx] = { kind: "entry", key, value, prefix, raw: [{ text: prefix + escapedValue, eol: lastEol }] };
    } else {
      const last = lines[lines.length - 1];
      if (last) {
        const lastRaw = last.raw[last.raw.length - 1]!;
        if (lastRaw.eol === "") {
          lines[lines.length - 1] = { ...last, raw: [...last.raw.slice(0, -1), { ...lastRaw, eol: doc.eol }] } as PropertiesLine;
        }
      }
      const prefix = `${escapePropertyKey(key, opts)}=`;
      lines.push({ kind: "entry", key, value, prefix, raw: [{ text: prefix + escapedValue, eol: doc.eol }] });
    }
  }
  return { lines, eol: doc.eol };
}

/** Convenience: parse → set → serialize. */
export function updatePropertiesText(text: string, values: Readonly<Record<string, PropertyValue>>): string {
  return serializeProperties(setProperties(parseProperties(text), values));
}
