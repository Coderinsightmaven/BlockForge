import { isForbiddenKey } from "./safe.js";

/**
 * Source-preserving JSON editor: a small recursive-descent parser records the source range of
 * every value, so scalar edits replace only that range and new keys are inserted after the last
 * member of their object with the object's member indentation. Blank lines, inline arrays,
 * number spellings and `\u` escapes elsewhere in the file are kept (Wings re-serialises the whole
 * file with 4-space indentation).
 */

export class JsonSourceError extends Error {
  constructor(message: string, readonly pos: number) {
    super(`${message} at offset ${pos}`);
    this.name = "JsonSourceError";
  }
}

type JNode =
  | { kind: "object"; start: number; end: number; members: Array<{ key: string; keyStart: number; value: JNode }> }
  | { kind: "array"; start: number; end: number; items: JNode[] }
  | { kind: "scalar"; start: number; end: number; value: string | number | boolean | null };

class Parser {
  i = 0;
  constructor(readonly s: string) {}
  ws() {
    while (this.i < this.s.length && /[ \t\r\n]/.test(this.s[this.i]!)) this.i++;
  }
  value(depth: number): JNode {
    if (depth > 512) throw new JsonSourceError("nesting too deep", this.i);
    this.ws();
    const c = this.s[this.i];
    const start = this.i;
    if (c === "{") {
      this.i++;
      const members: Array<{ key: string; keyStart: number; value: JNode }> = [];
      this.ws();
      if (this.s[this.i] === "}") {
        this.i++;
        return { kind: "object", start, end: this.i, members };
      }
      for (;;) {
        this.ws();
        if (this.s[this.i] !== '"') throw new JsonSourceError("expected a key", this.i);
        const keyStart = this.i;
        const key = this.string();
        this.ws();
        if (this.s[this.i] !== ":") throw new JsonSourceError("expected ':'", this.i);
        this.i++;
        members.push({ key, keyStart, value: this.value(depth + 1) });
        this.ws();
        if (this.s[this.i] === ",") {
          this.i++;
          continue;
        }
        if (this.s[this.i] === "}") {
          this.i++;
          return { kind: "object", start, end: this.i, members };
        }
        throw new JsonSourceError("expected ',' or '}'", this.i);
      }
    }
    if (c === "[") {
      this.i++;
      const items: JNode[] = [];
      this.ws();
      if (this.s[this.i] === "]") {
        this.i++;
        return { kind: "array", start, end: this.i, items };
      }
      for (;;) {
        items.push(this.value(depth + 1));
        this.ws();
        if (this.s[this.i] === ",") {
          this.i++;
          continue;
        }
        if (this.s[this.i] === "]") {
          this.i++;
          return { kind: "array", start, end: this.i, items };
        }
        throw new JsonSourceError("expected ',' or ']'", this.i);
      }
    }
    if (c === '"') {
      const value = this.string();
      return { kind: "scalar", start, end: this.i, value };
    }
    const m = /^(?:-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?|true|false|null)/.exec(this.s.slice(this.i, this.i + 400));
    if (!m) throw new JsonSourceError("unexpected token", this.i);
    this.i += m[0].length;
    const raw = m[0];
    return { kind: "scalar", start, end: this.i, value: raw === "true" ? true : raw === "false" ? false : raw === "null" ? null : Number(raw) };
  }
  string(): string {
    const start = this.i;
    this.i++;
    for (;;) {
      const c = this.s[this.i];
      if (c === undefined) throw new JsonSourceError("unterminated string", start);
      if (c === "\\") {
        this.i += 2;
        continue;
      }
      this.i++;
      if (c === '"') break;
      if (c < " ") throw new JsonSourceError("control character in string", this.i - 1);
    }
    return JSON.parse(this.s.slice(start, this.i)) as string;
  }
}

export function parseJsonSource(text: string): JNode {
  const p = new Parser(text);
  const v = p.value(0);
  p.ws();
  if (p.i !== text.length) throw new JsonSourceError("trailing content", p.i);
  return v;
}

function find(node: JNode, path: readonly (string | number)[]): { node: JNode | null; parent: JNode | null; depth: number } {
  let cur: JNode = node;
  let parent: JNode | null = null;
  for (let d = 0; d < path.length; d++) {
    const seg = path[d]!;
    parent = cur;
    if (cur.kind === "object" && typeof seg === "string") {
      const ms = cur.members.filter((m) => m.key === seg);
      const m = ms[ms.length - 1];
      if (!m) return { node: null, parent: cur, depth: d };
      cur = m.value;
    } else if (cur.kind === "array" && typeof seg === "number") {
      const it = cur.items[seg];
      if (!it) return { node: null, parent: cur, depth: d };
      cur = it;
    } else {
      return { node: null, parent: cur, depth: d };
    }
  }
  return { node: cur, parent, depth: path.length };
}

function lineIndent(text: string, pos: number): string {
  const ls = text.lastIndexOf("\n", pos - 1) + 1;
  return /^[ \t]*/.exec(text.slice(ls, pos))![0];
}

function render(value: unknown, indent: string, unit: string, eol: string): string {
  const s = JSON.stringify(value, null, unit);
  return s.replace(/\n/g, eol + indent);
}

/**
 * Sets `value` at `path` (creating missing object members). Returns null when the change cannot
 * be made at the source level (e.g. the path runs through a scalar or a missing list element).
 */
export function jsonSetInSource(text: string, path: readonly (string | number)[], value: unknown): string | null {
  if (path.some((seg) => typeof seg === "string" && isForbiddenKey(seg))) throw new JsonSourceError("forbidden path segment", 0);
  const root = parseJsonSource(text);
  const eol = /\r\n/.test(text) ? "\r\n" : "\n";
  const { node, parent, depth } = find(root, path);
  if (node) {
    const indent = lineIndent(text, node.start);
    const unit = guessUnit(text, root);
    return text.slice(0, node.start) + render(value, indent, unit, eol) + text.slice(node.end);
  }
  if (!parent || parent.kind !== "object") return null;
  const rest = path.slice(depth);
  if (rest.some((s) => typeof s === "number")) return null;
  // build the nested value for the missing remainder
  let nested: unknown = value;
  for (let k = rest.length - 1; k >= 1; k--) nested = { [rest[k] as string]: nested };
  const key = rest[0] as string;
  const unit = guessUnit(text, root);
  if (parent.members.length === 0) {
    const indent = lineIndent(text, parent.start);
    const inner = indent + unit;
    const body = `${eol}${inner}${JSON.stringify(key)}: ${render(nested, inner, unit, eol)}${eol}${indent}`;
    return text.slice(0, parent.start + 1) + body + text.slice(parent.end - 1);
  }
  const last = parent.members[parent.members.length - 1]!;
  const memberIndent = lineIndent(text, last.keyStart);
  const sameLine = !/\n/.test(text.slice(parent.start, last.keyStart));
  const sep = sameLine ? " " : `${eol}${memberIndent}`;
  const insert = `,${sep}${JSON.stringify(key)}: ${render(nested, sameLine ? "" : memberIndent, unit, eol)}`;
  return text.slice(0, last.value.end) + insert + text.slice(last.value.end);
}

function guessUnit(text: string, root: JNode): string {
  if (root.kind === "object" && root.members.length > 0) {
    const ind = lineIndent(text, root.members[0]!.keyStart);
    if (ind.length > 0 && /\n[ \t]*$/.test(text.slice(0, root.members[0]!.keyStart))) return ind;
  }
  return "    ";
}
