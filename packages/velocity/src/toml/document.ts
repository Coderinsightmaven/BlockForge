import { parse as parseToml } from "smol-toml";
import { type HeaderStmt, type KeyValueStmt, type Line, type Stmt, TomlSyntaxError, samePath, scanStatements, splitLines } from "./lexer.js";

const isHeader = (s: Stmt): s is HeaderStmt => s.kind === "header";

/**
 * Targeted, format-preserving TOML editor (velocity.toml, FabricProxy-Lite.toml,
 * proxy-compatible-forge.toml). Only the value range of edited statements (or the body of a
 * replaced table) changes; every other byte — comments, blank lines, key order, quoting style,
 * line endings — is preserved. Every mutation is validated by parsing the result with smol-toml
 * and rolled back if it would produce invalid TOML.
 */

export type TomlScalar = string | number | boolean;
export type TomlEditValue = TomlScalar | readonly string[];
/** `""`/`[]` = root table; a plain string is ONE segment (not split on dots). */
export type TablePath = string | readonly string[];
/** A plain string is ONE key segment (not split on dots). */
export type KeyPath = string | readonly string[];

export interface TomlEntry {
  key: KeyPath;
  value: TomlEditValue;
}

export class TomlEditError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "TomlEditError";
  }
}

const toPath = (p: TablePath | KeyPath): string[] => (typeof p === "string" ? (p === "" ? [] : [p]) : [...p]);

export function formatKey(segment: string): string {
  return /^[A-Za-z0-9_-]+$/.test(segment) ? segment : formatString(segment);
}

export function formatKeyPath(path: readonly string[]): string {
  return path.map(formatKey).join(".");
}

/** TOML basic string with all required escapes. */
export function formatString(s: string): string {
  let out = '"';
  for (const ch of s) {
    const cp = ch.codePointAt(0)!;
    if (ch === '"') out += '\\"';
    else if (ch === "\\") out += "\\\\";
    else if (ch === "\n") out += "\\n";
    else if (ch === "\t") out += "\\t";
    else if (ch === "\r") out += "\\r";
    else if (ch === "\b") out += "\\b";
    else if (ch === "\f") out += "\\f";
    else if (cp < 0x20 || cp === 0x7f) out += `\\u${cp.toString(16).toUpperCase().padStart(4, "0")}`;
    else out += ch;
  }
  return `${out}"`;
}

/** Renders a value; non-empty arrays use Velocity's default multi-line style (4-space indent). */
export function formatValue(v: TomlEditValue): string[] {
  if (typeof v === "string") return [formatString(v)];
  if (typeof v === "boolean") return [v ? "true" : "false"];
  if (typeof v === "number") {
    if (!Number.isFinite(v)) throw new TomlEditError("TOML numbers must be finite");
    return [Number.isInteger(v) ? String(v) : String(v).includes(".") || String(v).includes("e") ? String(v) : `${v}.0`];
  }
  if (v.length === 0) return ["[]"];
  return ["[", ...v.map((s, i) => `    ${formatString(s)}${i < v.length - 1 ? "," : ""}`), "]"];
}

function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a === "bigint" || typeof b === "bigint") return String(a) === String(b);
  if (Array.isArray(a) && Array.isArray(b)) return a.length === b.length && a.every((x, i) => deepEqual(x, b[i]));
  return false;
}

function lookup(data: unknown, path: readonly string[]): unknown {
  let cur: unknown = data;
  for (const seg of path) {
    if (cur === null || typeof cur !== "object" || Array.isArray(cur)) return undefined;
    if (!Object.prototype.hasOwnProperty.call(cur, seg)) return undefined;
    cur = (cur as Record<string, unknown>)[seg];
  }
  return cur;
}

export class TomlDocument {
  private lines: Line[];
  private stmts: Stmt[];
  readonly eol: "\n" | "\r\n";
  /** A leading UTF-8 byte order mark is kept out of the lines and written back unchanged. */
  private readonly bom: boolean;

  private constructor(lines: Line[], bom: boolean) {
    this.lines = lines;
    this.bom = bom;
    this.stmts = scanStatements(lines);
    const crlf = lines.filter((l) => l.eol === "\r\n").length;
    const lf = lines.filter((l) => l.eol === "\n").length;
    this.eol = crlf > lf ? "\r\n" : "\n";
  }

  /** Parses text; throws TomlSyntaxError / TomlEditError for documents that are not valid TOML. */
  static parse(text: string): TomlDocument {
    const bom = text.startsWith("\uFEFF");
    const doc = new TomlDocument(splitLines(bom ? text.slice(1) : text), bom);
    doc.data();
    return doc;
  }

  toString(): string {
    return (this.bom ? "\uFEFF" : "") + this.body();
  }

  private body(): string {
    return this.lines.map((l) => l.text + l.eol).join("");
  }

  /** Full semantic content (smol-toml). */
  data(): Record<string, unknown> {
    try {
      return parseToml(this.body()) as Record<string, unknown>;
    } catch (cause) {
      throw new TomlEditError(`invalid TOML: ${(cause as Error).message}`, { cause });
    }
  }

  validate(): { ok: true } | { ok: false; error: string } {
    try {
      this.data();
      return { ok: true };
    } catch (e) {
      return { ok: false, error: (e as Error).message };
    }
  }

  get(table: TablePath, key: KeyPath): unknown {
    return lookup(this.data(), [...toPath(table), ...toPath(key)]);
  }

  has(table: TablePath, key: KeyPath): boolean {
    return this.findKv(toPath(table), toPath(key)) !== undefined;
  }

  hasTable(table: TablePath): boolean {
    const t = toPath(table);
    return t.length === 0 || this.stmts.some((s) => s.kind === "header" && samePath(s.path, t));
  }

  /** Key paths of the statements directly inside a table, in document order. */
  keys(table: TablePath): string[][] {
    const t = toPath(table);
    return this.kvs().filter((s) => samePath(s.table, t) && !s.inArrayOfTables).map((s) => s.key);
  }

  /** Sets (or inserts) one key. Returns false when the value was already equal (no bytes changed). */
  setValue(table: TablePath, key: KeyPath, value: TomlEditValue): boolean {
    const t = toPath(table);
    const k = toPath(key);
    if (k.length === 0) throw new TomlEditError("empty key");
    this.assertNotArrayOfTables(t);
    return this.mutate(() => {
      const existing = this.findKv(t, k);
      if (existing) {
        if (deepEqual(lookup(this.data(), [...t, ...k]), value)) return false;
        this.replaceValue(existing, formatValue(value));
        return true;
      }
      this.ensureTableRaw(t);
      this.insertLines(this.insertionIndex(t), this.renderStatement(k, value));
      return true;
    });
  }

  /** Removes a key (all lines of its statement). Returns false if it did not exist. */
  removeKey(table: TablePath, key: KeyPath): boolean {
    const s = this.findKv(toPath(table), toPath(key));
    if (!s) return false;
    return this.mutate(() => {
      this.lines.splice(s.startLine, s.endLine - s.startLine + 1);
      return true;
    });
  }

  /** Appends `[table]` at the end when it does not exist yet. */
  ensureTable(table: TablePath): boolean {
    const t = toPath(table);
    if (this.hasTable(t)) return false;
    return this.mutate(() => {
      this.ensureTableRaw(t);
      return true;
    });
  }

  /**
   * Replaces every key of a table with `entries` (in order). Keeps the table header, the comment
   * block before the first key, the blank lines after the last key, and comments attached
   * directly above a key that is kept. Entries whose key and value are unchanged keep their
   * original text (including inline comments).
   */
  replaceTableBody(table: TablePath, entries: readonly TomlEntry[]): boolean {
    const t = toPath(table);
    if (t.length === 0) throw new TomlEditError("replaceTableBody does not support the root table");
    this.assertNotArrayOfTables(t);
    const seen = new Set<string>();
    for (const e of entries) {
      const id = JSON.stringify(toPath(e.key));
      if (seen.has(id)) throw new TomlEditError(`duplicate key ${toPath(e.key).join(".")} in table ${t.join(".")}`);
      seen.add(id);
    }
    return this.mutate(() => {
      this.ensureTableRaw(t);
      const header = this.stmts.filter(isHeader).find((s) => samePath(s.path, t))!;
      const nextHeader = this.stmts.filter(isHeader).find((s) => s.line > header.line);
      const bodyStart = header.line + 1;
      const bodyEnd = nextHeader ? nextHeader.line : this.lines.length; // exclusive
      const kvs = this.kvs().filter((s) => s.startLine >= bodyStart && s.startLine < bodyEnd);
      const oldData = lookup(this.data(), t);

      let leading: Line[];
      let trailing: Line[];
      const attached = new Map<string, Line[]>();
      const raw = new Map<string, Line[]>();
      if (kvs.length === 0) {
        // Keep comment lines directly under the header; trailing blank lines stay trailing.
        let end = bodyEnd;
        while (end > bodyStart && this.lines[end - 1]!.text.trim() === "") end--;
        leading = this.lines.slice(bodyStart, end);
        trailing = this.lines.slice(end, bodyEnd);
      } else {
        leading = this.lines.slice(bodyStart, kvs[0]!.startLine);
        trailing = this.lines.slice(kvs[kvs.length - 1]!.endLine + 1, bodyEnd);
        kvs.forEach((s, idx) => {
          const id = JSON.stringify(s.key);
          raw.set(id, this.lines.slice(s.startLine, s.endLine + 1));
          if (idx === 0) return;
          const prevEnd = kvs[idx - 1]!.endLine;
          let i = s.startLine - 1;
          while (i > prevEnd && this.lines[i]!.text.trimStart().startsWith("#")) i--;
          const comments = this.lines.slice(i + 1, s.startLine);
          const blankBefore = i > prevEnd && this.lines[i]!.text.trim() === "";
          if (comments.length > 0 || blankBefore) attached.set(id, [...(blankBefore ? [{ text: "", eol: this.eol }] : []), ...comments]);
        });
      }

      const body: Line[] = [...leading];
      for (const e of entries) {
        const k = toPath(e.key);
        const id = JSON.stringify(k);
        body.push(...(attached.get(id) ?? []));
        const old = raw.get(id);
        if (old && deepEqual(lookup(oldData, k), e.value)) {
          body.push(...old.map((l) => ({ ...l, eol: l.eol === "" ? this.eol : l.eol })));
        } else {
          body.push(...this.renderStatement(k, e.value));
        }
      }
      const isLast = !nextHeader;
      if (trailing.length === 0 && !isLast) trailing = [{ text: "", eol: this.eol }];
      body.push(...trailing);
      if (isLast && body.length > 0 && this.lines[bodyEnd - 1]?.eol === "") {
        const last = body[body.length - 1]!;
        body[body.length - 1] = { ...last, eol: "" };
      }
      const before = this.lines.slice(bodyStart, bodyEnd);
      if (before.length === body.length && before.every((l, i) => l.text === body[i]!.text && l.eol === body[i]!.eol)) return false;
      this.lines.splice(bodyStart, bodyEnd - bodyStart, ...body);
      return true;
    });
  }

  // ---- internals ---------------------------------------------------------------------------

  private kvs(): KeyValueStmt[] {
    return this.stmts.filter((s): s is KeyValueStmt => s.kind === "kv");
  }

  private findKv(table: string[], key: string[]): KeyValueStmt | undefined {
    return this.kvs().find((s) => !s.inArrayOfTables && samePath(s.table, table) && samePath(s.key, key));
  }

  private assertNotArrayOfTables(t: string[]): void {
    if (t.length > 0 && this.stmts.some((s) => s.kind === "header" && s.arrayOfTables && samePath(s.path, t))) {
      throw new TomlEditError(`[[${t.join(".")}]] is an array of tables; editing it is not supported`);
    }
  }

  private mutate(fn: () => boolean): boolean {
    const saved = this.lines.map((l) => ({ ...l }));
    try {
      const changed = fn();
      if (!changed) return false;
      this.stmts = scanStatements(this.lines);
      this.data();
      return true;
    } catch (e) {
      this.lines = saved;
      this.stmts = scanStatements(saved);
      if (e instanceof TomlEditError || e instanceof TomlSyntaxError) throw e;
      throw new TomlEditError(`edit failed: ${(e as Error).message}`, { cause: e });
    }
  }

  private renderStatement(key: string[], value: TomlEditValue): Line[] {
    const v = formatValue(value);
    const first = `${formatKeyPath(key)} = ${v[0]}`;
    return [first, ...v.slice(1)].map((text) => ({ text, eol: this.eol }));
  }

  private replaceValue(s: KeyValueStmt, rendered: string[]): void {
    const firstLine = this.lines[s.valueStart.line]!;
    const lastLine = this.lines[s.valueEnd.line]!;
    const prefix = firstLine.text.slice(0, s.valueStart.col);
    const suffix = lastLine.text.slice(s.valueEnd.col);
    const out: Line[] = rendered.map((text, i) => ({
      text: (i === 0 ? prefix : "") + text + (i === rendered.length - 1 ? suffix : ""),
      eol: i === rendered.length - 1 ? lastLine.eol : this.eol,
    }));
    this.lines.splice(s.valueStart.line, s.valueEnd.line - s.valueStart.line + 1, ...out);
  }

  private ensureTableRaw(t: string[]): void {
    if (t.length === 0 || this.stmts.some((s) => s.kind === "header" && samePath(s.path, t))) return;
    const last = this.lines[this.lines.length - 1];
    const add: Line[] = [];
    if (last && last.eol === "") {
      if (last.text === "" && this.lines.length === 1) this.lines.pop();
      else this.lines[this.lines.length - 1] = { ...last, eol: this.eol };
    }
    const tail = this.lines[this.lines.length - 1];
    if (tail && tail.text.trim() !== "") add.push({ text: "", eol: this.eol });
    add.push({ text: `[${formatKeyPath(t)}]`, eol: this.eol });
    this.lines.push(...add);
    this.stmts = scanStatements(this.lines);
  }

  /** Line index where a new key of table `t` is inserted. */
  private insertionIndex(t: string[]): number {
    const inTable = this.kvs().filter((s) => !s.inArrayOfTables && samePath(s.table, t));
    if (inTable.length > 0) return inTable[inTable.length - 1]!.endLine + 1;
    if (t.length === 0) {
      const firstHeader = this.stmts.find(isHeader);
      if (!firstHeader) return this.lines.length;
      let i = firstHeader.line;
      while (i > 0 && this.lines[i - 1]!.text.trim() === "") i--;
      return i;
    }
    const header = this.stmts.filter(isHeader).find((s) => samePath(s.path, t))!;
    let i = header.line + 1;
    while (i < this.lines.length && this.lines[i]!.text.trimStart().startsWith("#")) i++;
    return i;
  }

  private insertLines(index: number, add: Line[]): void {
    if (this.lines.length === 1 && this.lines[0]!.text === "" && this.lines[0]!.eol === "") {
      this.lines = [...add];
      return;
    }
    if (index > 0) {
      const prev = this.lines[index - 1]!;
      if (prev.eol === "") this.lines[index - 1] = { ...prev, eol: this.eol };
    }
    this.lines.splice(index, 0, ...add);
  }
}
