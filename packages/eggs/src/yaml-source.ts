import { type Document, isCollection, isMap, isPair, isScalar, isSeq, parseDocument, type Node, type Pair, type Scalar, type YAMLMap } from "yaml";

/**
 * Source-preserving YAML editor (eemeli/yaml provides the node ranges).
 *
 *  - Existing scalars are replaced in place (only their source range changes; quoting style kept).
 *  - Missing keys are inserted as new lines below the last entry of the deepest existing block
 *    mapping, with that mapping's indentation and the file's line ending.
 *  - String lists are written in place (block or flow, matching the existing node).
 *  - A UTF-8 BOM and CRLF line endings are preserved.
 * Anything that cannot be done at the source level (flow mappings, writing through a scalar,
 * replacing a mapping) either fails (`fallback: "fail"`, the default) or re-serialises the whole
 * document through the Document API (`fallback: "reserialize"`, comments kept but layout may
 * change) — the caller decides which is acceptable.
 */

export type YamlPath = readonly (string | number)[];
export type YamlScalar = string | number | boolean | null;
export type YamlSetValue = YamlScalar | readonly string[];

export class YamlEditError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "YamlEditError";
  }
}

export interface YamlEditOptions {
  fallback?: "fail" | "reserialize";
}

const BOM = "\uFEFF";
const RESERVED_PLAIN = /^(?:true|false|yes|no|on|off|y|n|null|~|[-+]?(?:\.inf|\.nan)|[-+]?[0-9][0-9_.:eE+-]*|0x[0-9a-fA-F]+|0o[0-7]+)$/i;

function hasControlChars(s: string): boolean {
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if ((c < 0x20 && c !== 0x09) || c === 0x7f) return true;
  }
  return false;
}

/**
 * A plain scalar is used only when it reads back as the same string under both YAML 1.2 (eemeli)
 * and YAML 1.1 (SnakeYAML, used by Bukkit/BungeeCord): no booleans like `on`, numbers, nulls,
 * timestamps, sexagesimals or indicator characters.
 */
function plainIsSafe(value: string): boolean {
  if (value === "" || value !== value.trim() || !/^[A-Za-z0-9_./][^#'"{}[\],&*!|>%@`]*$/.test(value) || /: |\s#|:$/.test(value)) return false;
  for (const version of ["1.1", "1.2"] as const) {
    try {
      const doc = parseDocument(`k: ${value}\n`, { version });
      if (doc.errors.length > 0) return false;
      if (doc.get("k") !== value) return false;
    } catch {
      return false;
    }
  }
  return true;
}

/** Renders a scalar; `style` is the existing node's quoting style when replacing in place. */
export function renderYamlScalar(value: YamlScalar, style?: Scalar.Type | string): string {
  if (value === null) return "null";
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new YamlEditError("YAML numbers must be finite");
    return String(value);
  }
  if (typeof value === "boolean") return value ? "true" : "false";
  if (style === "QUOTE_DOUBLE" || hasControlChars(value)) return JSON.stringify(value);
  if ((style === "PLAIN" || style === undefined) && plainIsSafe(value)) return value;
  return `'${value.replace(/'/g, "''")}'`;
}

export function renderYamlKey(key: string): string {
  return /^[A-Za-z0-9_][A-Za-z0-9_.-]*$/.test(key) && !RESERVED_PLAIN.test(key) ? key : renderYamlScalar(key, "QUOTE_SINGLE");
}

function sameValue(a: unknown, b: YamlSetValue): boolean {
  if (Array.isArray(b)) return Array.isArray(a) && a.length === b.length && a.every((x, i) => x === b[i]);
  return a === b;
}

export function parseYamlStrict(text: string): Document {
  const doc = parseDocument(text, { prettyErrors: false });
  if (doc.errors.length > 0) throw new YamlEditError(`invalid YAML: ${doc.errors[0]!.message}`);
  return doc;
}

/** Plain JS value at `path` (undefined when absent). */
export function yamlGet(text: string, path: YamlPath): unknown {
  const doc = parseYamlStrict(text.startsWith(BOM) ? text.slice(1) : text);
  const n = doc.getIn(path, true);
  if (n === undefined) return undefined;
  if (isCollection(n)) return n.toJSON();
  if (isScalar(n)) return n.value;
  return n;
}

function lineStart(text: string, pos: number): number {
  return text.lastIndexOf("\n", pos - 1) + 1;
}

function column(text: string, pos: number): number {
  return pos - lineStart(text, pos);
}

/** Position just after the line break that ends the line containing `pos - 1`. */
function endOfLine(text: string, pos: number): number {
  if (pos > 0 && text[pos - 1] === "\n") return pos;
  const nl = text.indexOf("\n", pos);
  return nl === -1 ? text.length : nl + 1;
}

/** valueEnd of the last scalar/flow node inside `node` (deepest last descendant). */
function lastValueEnd(node: Node): number {
  if (isMap(node) && !node.flow && node.items.length > 0) {
    const last = node.items[node.items.length - 1]!;
    const v = last.value as Node | null;
    if (v && (v as { range?: unknown }).range) return lastValueEnd(v);
    return (last.key as Node).range![1];
  }
  if (isSeq(node) && !node.flow && node.items.length > 0) return lastValueEnd(node.items[node.items.length - 1] as Node);
  return node.range![1];
}

function detectEol(text: string): "\n" | "\r\n" {
  const crlf = (text.match(/\r\n/g) ?? []).length;
  const lf = (text.match(/\n/g) ?? []).length - crlf;
  return crlf > lf ? "\r\n" : "\n";
}

function detectIndentUnit(doc: Document, text: string): number {
  let unit = 0;
  const visit = (n: unknown, parentCol: number | null) => {
    if (isMap(n) && !n.flow) {
      for (const p of n.items) {
        const k = p.key as Node | null;
        if (!k?.range) continue;
        const col = column(text, k.range[0]);
        if (parentCol !== null && col > parentCol && (unit === 0 || col - parentCol < unit)) unit = col - parentCol;
        visit(p.value, col);
      }
    } else if (isSeq(n) && !n.flow) {
      for (const it of n.items) visit(it, parentCol);
    }
  };
  visit(doc.contents, null);
  return unit || 2;
}

function renderBlock(path: readonly string[], value: YamlSetValue, indent: number, unit: number, eol: string): string {
  let out = "";
  path.forEach((seg, i) => {
    const pad = " ".repeat(indent + i * unit);
    const last = i === path.length - 1;
    if (!last) out += `${pad}${renderYamlKey(seg)}:${eol}`;
    else if (Array.isArray(value)) {
      out += value.length === 0 ? `${pad}${renderYamlKey(seg)}: []${eol}` : `${pad}${renderYamlKey(seg)}:${eol}${value.map((v) => `${pad}- ${renderYamlScalar(v)}${eol}`).join("")}`;
    } else out += `${pad}${renderYamlKey(seg)}: ${renderYamlScalar(value as YamlScalar)}${eol}`;
  });
  return out;
}

function findPair(map: YAMLMap, key: string | number): Pair | undefined {
  return map.items.find((p) => isPair(p) && p.key !== null && String(isScalar(p.key) ? p.key.value : p.key) === String(key));
}

class SourceEdit {
  text: string;
  private readonly bom: boolean;
  readonly eol: "\n" | "\r\n";

  constructor(text: string) {
    this.bom = text.startsWith(BOM);
    this.text = this.bom ? text.slice(1) : text;
    this.eol = detectEol(this.text);
  }

  doc(): Document {
    return parseYamlStrict(this.text);
  }

  result(): string {
    return (this.bom ? BOM : "") + this.text;
  }

  splice(start: number, end: number, insert: string): void {
    this.text = this.text.slice(0, start) + insert + this.text.slice(end);
  }

  /** Returns false when the edit cannot be done at the source level. */
  set(path: YamlPath, value: YamlSetValue): boolean {
    const doc = this.doc();
    const unit = detectIndentUnit(doc, this.text);
    // Walk to the deepest existing node.
    let node: unknown = doc.contents;
    let parentKeyNode: Node | null = null; // key whose value is `node`
    let i = 0;
    for (; i < path.length; i++) {
      const seg = path[i]!;
      if (isMap(node)) {
        const pair = findPair(node, seg);
        if (!pair) break;
        parentKeyNode = pair.key as Node;
        node = pair.value;
        if (node === null) {
          if (i === path.length - 1) break;
          return this.insertUnderNullKey(parentKeyNode, path.slice(i + 1) as string[], value, unit) || false;
        }
      } else if (isSeq(node) && typeof seg === "number") {
        if (seg < 0 || seg >= node.items.length) return false;
        parentKeyNode = null;
        node = node.items[seg];
      } else {
        // Path continues through a scalar / flow / missing root
        if (node === null || node === undefined || (isScalar(node) && node.value === null && i === 0)) break;
        return false;
      }
    }

    if (i === path.length) {
      return this.replaceNode(node, parentKeyNode, value);
    }
    // missing remainder
    const rest = path.slice(i);
    if (rest.some((s) => typeof s === "number")) return false;
    const restKeys = rest as string[];
    if (node === null || node === undefined || (isScalar(node) && node.value === null && !(node as Scalar).range?.[1])) {
      // empty document or root
      if (doc.contents && !(isScalar(doc.contents) && doc.contents.value === null)) return false;
      const sep = this.text.length > 0 && !this.text.endsWith("\n") ? this.eol : "";
      this.text += sep + renderBlock(restKeys, value, 0, unit, this.eol);
      return true;
    }
    if (isMap(node)) {
      if (node.flow) return false;
      if (node.items.length === 0) return false;
      const firstKey = node.items[0]!.key as Node;
      const indent = column(this.text, firstKey.range![0]);
      const at = endOfLine(this.text, lastValueEnd(node));
      const needsBreak = at === this.text.length && at > 0 && !this.text.endsWith("\n");
      this.splice(at, at, (needsBreak ? this.eol : "") + renderBlock(restKeys, value, indent, unit, this.eol));
      return true;
    }
    if (isScalar(node) && node.value === null && parentKeyNode) {
      return this.insertUnderNullKey(parentKeyNode, restKeys, value, unit);
    }
    return false;
  }

  private insertUnderNullKey(keyNode: Node, rest: string[], value: YamlSetValue, unit: number): boolean {
    const indent = column(this.text, keyNode.range![0]) + unit;
    const at = endOfLine(this.text, keyNode.range![1]);
    const lineText = this.text.slice(lineStart(this.text, keyNode.range![0]), at);
    // only `key:` (optionally followed by a comment) may be extended
    if (!/^\s*[^#]*:\s*(#.*)?\r?\n?$/.test(lineText)) return false;
    const needsBreak = at === this.text.length && !this.text.endsWith("\n");
    this.splice(at, at, (needsBreak ? this.eol : "") + renderBlock(rest, value, indent, unit, this.eol));
    return true;
  }

  private replaceNode(node: unknown, keyNode: Node | null, value: YamlSetValue): boolean {
    if (Array.isArray(value)) {
      if (isSeq(node) && node.items.every((it) => isScalar(it))) {
        const seq = node;
        if (seq.flow || value.length === 0) {
          const [s, e] = seq.flow ? [seq.range![0], seq.range![1]] : [seq.range![0], (seq.items[seq.items.length - 1] as Node).range![1]];
          if (!seq.flow && keyNode) {
            // block → `[]` on the key line
            const keyEnd = keyNode.range![1];
            const colon = this.text.indexOf(":", keyEnd);
            this.splice(colon + 1, e, " []");
            return true;
          }
          this.splice(s, e, `[${value.map((v) => renderYamlScalar(v, "QUOTE_SINGLE")).join(", ")}]`);
          return true;
        }
        const dashCol = column(this.text, seq.range![0]);
        const lastEnd = (seq.items[seq.items.length - 1] as Node).range![1];
        const rendered = value.map((v, idx) => `${idx === 0 ? "" : " ".repeat(dashCol)}- ${renderYamlScalar(v)}`).join(this.eol);
        this.splice(seq.range![0], lastEnd, rendered);
        return true;
      }
      if (isScalar(node) && keyNode && node.value === null && node.range && node.range[0] === node.range[1]) {
        // `key:` with nothing after it (optionally a comment): add the list
        const colon = this.text.indexOf(":", keyNode.range![1]);
        if (value.length === 0) {
          this.splice(colon + 1, colon + 1, " []");
          return true;
        }
        const indent = column(this.text, keyNode.range![0]);
        const at = endOfLine(this.text, keyNode.range![1]);
        const needsBreak = at === this.text.length && !this.text.endsWith("\n");
        this.splice(at, at, (needsBreak ? this.eol : "") + value.map((v) => `${" ".repeat(indent)}- ${renderYamlScalar(v)}${this.eol}`).join(""));
        return true;
      }
      return false;
    }
    if (isScalar(node) && node.range && node.type !== "BLOCK_FOLDED" && node.type !== "BLOCK_LITERAL") {
      if (node.range[0] === node.range[1] && keyNode) {
        // `key:` with an empty (null) value
        const colon = this.text.indexOf(":", keyNode.range![1]);
        this.splice(colon + 1, colon + 1, ` ${renderYamlScalar(value as YamlScalar)}`);
        return true;
      }
      this.splice(node.range[0], node.range[1], renderYamlScalar(value as YamlScalar, node.type));
      return true;
    }
    return false;
  }
}

export interface YamlSetResult {
  text: string;
  changed: boolean;
  /** True when the whole document was re-serialised (fallback "reserialize"). */
  reserialized: boolean;
}

/** Applies edits in order. Values already equal are left untouched (no bytes change). */
export function yamlSetMany(text: string | null, edits: readonly { path: YamlPath; value: YamlSetValue }[], opts: YamlEditOptions = {}): YamlSetResult {
  const ed = new SourceEdit(text ?? "");
  let reserialized = false;
  let changed = false;
  for (const e of edits) {
    if (e.path.length === 0) throw new YamlEditError("empty YAML path");
    const doc = ed.doc();
    if (doc.contents !== null && !isMap(doc.contents) && !(isScalar(doc.contents) && doc.contents.value === null)) {
      throw new YamlEditError("top-level YAML node is not a mapping");
    }
    const current = (() => {
      const n = doc.getIn(e.path, true);
      if (n === undefined) return undefined;
      return isCollection(n) ? n.toJSON() : isScalar(n) ? n.value : n;
    })();
    if (sameValue(current, e.value)) continue;
    const before = ed.text;
    let ok: boolean;
    try {
      ok = ed.set(e.path, e.value);
    } catch (err) {
      if (!(err instanceof YamlEditError)) throw err;
      ok = false;
    }
    if (ok) {
      try {
        const after = ed.doc().getIn(e.path, true);
        const v = after === undefined ? undefined : isCollection(after) ? after.toJSON() : isScalar(after) ? after.value : after;
        if (!sameValue(v, e.value)) ok = false;
      } catch {
        ok = false;
      }
    }
    if (!ok) {
      ed.text = before;
      if ((opts.fallback ?? "fail") === "fail") {
        throw new YamlEditError(`cannot edit ${e.path.join(".")} without re-serialising the document`);
      }
      const d = ed.doc();
      d.setIn([...e.path], Array.isArray(e.value) ? d.createNode([...e.value]) : e.value);
      ed.text = d.toString({ lineWidth: 0 });
      if (ed.eol === "\r\n") ed.text = ed.text.replace(/\r?\n/g, "\r\n");
      reserialized = true;
    }
    changed = true;
  }
  return { text: changed ? ed.result() : (text ?? ""), changed, reserialized };
}

/** Replaces non-empty scalars at `paths` (and every scalar item of sequences there) with `mask`. */
export function yamlMaskPaths(text: string, paths: readonly YamlPath[], mask: string): string {
  const bom = text.startsWith(BOM);
  const body = bom ? text.slice(1) : text;
  const doc = parseYamlStrict(body);
  const splices: Array<{ start: number; end: number; text: string }> = [];
  const maskNode = (node: unknown) => {
    if (isScalar(node) && node.range && node.value !== null && node.value !== "") {
      splices.push({ start: node.range[0], end: node.range[1], text: renderYamlScalar(mask, node.type === "PLAIN" ? "QUOTE_SINGLE" : node.type) });
    } else if (isSeq(node)) {
      for (const item of node.items) maskNode(item);
    }
  };
  for (const p of paths) maskNode(doc.getIn(p, true));
  splices.sort((a, b) => b.start - a.start);
  let out = body;
  for (const s of splices) out = out.slice(0, s.start) + s.text + out.slice(s.end);
  return (bom ? BOM : "") + out;
}
