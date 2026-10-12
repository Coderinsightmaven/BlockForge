/**
 * Line-oriented TOML statement scanner. It does not build values; it only locates table headers,
 * key/value statements (which may span lines: multi-line arrays and strings) and the exact
 * character range of every value, so edits can replace just that range and keep everything else
 * (comments, spacing, ordering, line endings) byte-for-byte. Value semantics come from smol-toml.
 */

export type Eol = "\n" | "\r\n" | "";

export interface Line {
  text: string;
  eol: Eol;
}

export interface Pos {
  line: number;
  col: number;
}

export interface HeaderStmt {
  kind: "header";
  line: number;
  path: string[];
  arrayOfTables: boolean;
}

export interface KeyValueStmt {
  kind: "kv";
  /** Table the statement belongs to ([] = root). */
  table: string[];
  /** True when the enclosing header is an array of tables (`[[x]]`). */
  inArrayOfTables: boolean;
  key: string[];
  startLine: number;
  endLine: number;
  /** First character of the value. */
  valueStart: Pos;
  /** One past the last character of the value. */
  valueEnd: Pos;
}

export type Stmt = HeaderStmt | KeyValueStmt;

export class TomlSyntaxError extends Error {
  readonly line: number;
  constructor(message: string, line: number) {
    super(`${message} (line ${line + 1})`);
    this.name = "TomlSyntaxError";
    this.line = line;
  }
}

export function splitLines(text: string): Line[] {
  const out: Line[] = [];
  let start = 0;
  for (let i = 0; i < text.length; i++) {
    if (text[i] === "\n") {
      const crlf = i > start - 1 && text[i - 1] === "\r";
      out.push({ text: text.slice(start, crlf ? i - 1 : i), eol: crlf ? "\r\n" : "\n" });
      start = i + 1;
    }
  }
  if (start < text.length || out.length === 0) out.push({ text: text.slice(start), eol: "" });
  return out;
}

const isWs = (c: string | undefined) => c === " " || c === "\t";
const BARE = /[A-Za-z0-9_-]/;

class Cursor {
  constructor(
    readonly lines: Line[],
    public line: number,
    public col: number,
  ) {}
  /** Current character (a method so TypeScript does not narrow it across cursor moves). */
  cur(): string | undefined {
    return this.lines[this.line]?.text[this.col];
  }
  peek(n: number): string {
    return this.lines[this.line]?.text.slice(this.col, this.col + n) ?? "";
  }
  atEol(): boolean {
    return this.col >= (this.lines[this.line]?.text.length ?? 0);
  }
  nextLine(): boolean {
    if (this.line + 1 >= this.lines.length) return false;
    this.line++;
    this.col = 0;
    return true;
  }
  skipWs(): void {
    while (isWs(this.cur())) this.col++;
  }
  pos(): Pos {
    return { line: this.line, col: this.col };
  }
}

/** Reads a basic ("…") or literal ('…') single-line string starting at the cursor; returns its decoded text. */
function readQuoted(c: Cursor): string {
  const q = c.cur()!;
  const startLine = c.line;
  c.col++;
  let out = "";
  for (;;) {
    const ch = c.cur();
    if (ch === undefined) throw new TomlSyntaxError("unterminated string", startLine);
    c.col++;
    if (ch === q) return out;
    if (q === '"' && ch === "\\") {
      const e = c.cur();
      c.col++;
      switch (e) {
        case "b":
          out += "\b";
          break;
        case "t":
          out += "\t";
          break;
        case "n":
          out += "\n";
          break;
        case "f":
          out += "\f";
          break;
        case "r":
          out += "\r";
          break;
        case '"':
          out += '"';
          break;
        case "\\":
          out += "\\";
          break;
        case "u":
        case "U": {
          const len = e === "u" ? 4 : 8;
          const hex = c.peek(len);
          if (!/^[0-9a-fA-F]+$/.test(hex) || hex.length !== len) throw new TomlSyntaxError("bad unicode escape", startLine);
          out += String.fromCodePoint(parseInt(hex, 16));
          c.col += len;
          break;
        }
        default:
          throw new TomlSyntaxError("bad escape", startLine);
      }
      continue;
    }
    out += ch;
  }
}

/** Skips a multi-line string ("""…""" or '''…''') that starts at the cursor. */
function skipMultiline(c: Cursor): void {
  const delim = c.peek(3);
  const startLine = c.line;
  c.col += 3;
  for (;;) {
    if (c.atEol()) {
      if (!c.nextLine()) throw new TomlSyntaxError("unterminated multi-line string", startLine);
      continue;
    }
    if (delim === '"""' && c.cur() === "\\") {
      c.col += 2;
      continue;
    }
    if (c.peek(3) === delim) {
      c.col += 3;
      // Up to two extra quotes may belong to the content ("""a"""" is a" + '"').
      while (c.cur() === delim[0] && c.peek(3) !== delim) c.col++;
      return;
    }
    c.col++;
  }
}

/** Skips whitespace, comments and line breaks inside an array. */
function skipBlank(c: Cursor, startLine: number): void {
  for (;;) {
    c.skipWs();
    skipComment(c);
    if (!c.atEol()) return;
    if (!c.nextLine()) throw new TomlSyntaxError("unterminated array", startLine);
  }
}

function skipComment(c: Cursor): void {
  if (c.cur() === "#") c.col = c.lines[c.line]!.text.length;
}

/** Reads a key (bare, quoted or dotted) at the cursor. */
function readKey(c: Cursor): string[] {
  const parts: string[] = [];
  for (;;) {
    c.skipWs();
    const ch = c.cur();
    if (ch === '"' || ch === "'") parts.push(readQuoted(c));
    else {
      let s = "";
      while (BARE.test(c.cur() ?? "")) s += c.lines[c.line]!.text[c.col++];
      if (s === "") throw new TomlSyntaxError("expected a key", c.line);
      parts.push(s);
    }
    c.skipWs();
    if (c.cur() === ".") {
      c.col++;
      continue;
    }
    return parts;
  }
}

/** Skips a value starting at the cursor (which must be at its first character). */
function skipValue(c: Cursor): void {
  const ch = c.cur();
  if (ch === undefined) throw new TomlSyntaxError("missing value", c.line);
  if (c.peek(3) === '"""' || c.peek(3) === "'''") return skipMultiline(c);
  if (ch === '"' || ch === "'") {
    readQuoted(c);
    return;
  }
  if (ch === "[") {
    const startLine = c.line;
    c.col++;
    for (;;) {
      skipBlank(c, startLine);
      if (c.cur() === "]") {
        c.col++;
        return;
      }
      skipValue(c);
      skipBlank(c, startLine);
      if (c.cur() === ",") {
        c.col++;
        continue;
      }
      if (c.cur() === "]") {
        c.col++;
        return;
      }
      throw new TomlSyntaxError("expected , or ] in array", c.line);
    }
  }
  if (ch === "{") {
    c.col++;
    c.skipWs();
    if (c.cur() === "}") {
      c.col++;
      return;
    }
    for (;;) {
      readKey(c);
      if (c.cur() !== "=") throw new TomlSyntaxError("expected = in inline table", c.line);
      c.col++;
      c.skipWs();
      skipValue(c);
      c.skipWs();
      if (c.cur() === ",") {
        c.col++;
        continue;
      }
      if (c.cur() === "}") {
        c.col++;
        return;
      }
      throw new TomlSyntaxError("expected , or } in inline table", c.line);
    }
  }
  // Bare scalar (number, boolean, date-time): up to a comment, comma or closing bracket.
  const text = c.lines[c.line]!.text;
  let end = c.col;
  while (end < text.length && text[end] !== "#" && text[end] !== "," && text[end] !== "]" && text[end] !== "}") end++;
  while (end > c.col && isWs(text[end - 1])) end--;
  if (end === c.col) throw new TomlSyntaxError("missing value", c.line);
  c.col = end;
}

export function scanStatements(lines: Line[]): Stmt[] {
  const out: Stmt[] = [];
  let table: string[] = [];
  let aot = false;
  for (let i = 0; i < lines.length; i++) {
    const c = new Cursor(lines, i, 0);
    c.skipWs();
    if (c.atEol() || c.cur() === "#") continue;
    if (c.cur() === "[") {
      const array = c.peek(2) === "[[";
      c.col += array ? 2 : 1;
      const path = readKey(c);
      if (array ? c.peek(2) !== "]]" : c.cur() !== "]") throw new TomlSyntaxError("malformed table header", i);
      c.col += array ? 2 : 1;
      c.skipWs();
      skipComment(c);
      if (!c.atEol()) throw new TomlSyntaxError("unexpected text after table header", i);
      out.push({ kind: "header", line: i, path, arrayOfTables: array });
      table = path;
      aot = array;
      continue;
    }
    const key = readKey(c);
    if (c.cur() !== "=") throw new TomlSyntaxError("expected '='", i);
    c.col++;
    c.skipWs();
    const valueStart = c.pos();
    skipValue(c);
    const valueEnd = c.pos();
    c.skipWs();
    skipComment(c);
    if (!c.atEol()) throw new TomlSyntaxError("unexpected text after value", c.line);
    out.push({ kind: "kv", table, inArrayOfTables: aot, key, startLine: i, endLine: c.line, valueStart, valueEnd });
    i = c.line;
  }
  return out;
}

export function samePath(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((x, i) => x === b[i]);
}
