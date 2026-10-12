import { Document, isCollection, isMap, isScalar, isSeq, parseDocument, type Scalar } from "yaml";

/**
 * Comment-preserving YAML edits (eemeli/yaml Document API).
 *
 * Existing scalar values are replaced *in place* using the node's source range, so every other
 * byte of the file stays untouched. Only when keys must be created (or a non-scalar replaced) is
 * the document re-serialised through the Document API, which still keeps comments, key order and
 * quoting styles. Sequence indentation is detected from the source (SnakeYAML/Configurate write
 * `- item` at the parent key's indentation).
 */

export class YamlEditError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "YamlEditError";
  }
}

export type YamlValue = string | number | boolean | null | readonly string[];

export interface YamlEdit {
  path: readonly (string | number)[];
  value: YamlValue;
}

const RESERVED_PLAIN = /^(?:true|false|yes|no|on|off|y|n|null|~|[-+]?(?:\.inf|\.nan)|[-+]?[0-9][0-9_.:eE+-]*)$/i;

function renderScalar(value: string | number | boolean | null, style: Scalar.Type | undefined): string {
  if (value === null) return "null";
  if (typeof value !== "string") return String(value);
  if (style === "QUOTE_DOUBLE") return JSON.stringify(value);
  const safePlain = /^[A-Za-z_][A-Za-z0-9_./-]*$/.test(value) && !RESERVED_PLAIN.test(value);
  if (style === "PLAIN" && safePlain) return value;
  if (hasControlChars(value)) return JSON.stringify(value);
  return `'${value.replace(/'/g, "''")}'`;
}

function hasControlChars(s: string): boolean {
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c < 0x20 || c === 0x7f) return true;
  }
  return false;
}

function equalValue(a: unknown, b: YamlValue): boolean {
  if (Array.isArray(b)) return Array.isArray(a) && a.length === b.length && a.every((x, i) => x === b[i]);
  return a === b;
}

function detectIndentSeq(text: string): boolean {
  const lines = text.split(/\r?\n/);
  for (let i = 0; i + 1 < lines.length; i++) {
    const m = /^(\s*)[^\s#-][^:#]*:\s*(?:#.*)?$/.exec(lines[i]!);
    if (!m) continue;
    const next = /^(\s*)- /.exec(lines[i + 1]!);
    if (next) return next[1]!.length > m[1]!.length;
  }
  return false;
}

/** Plain JS value at a path (collections are converted with toJSON). */
function valueAt(doc: Document, path: readonly (string | number)[]): unknown {
  const n = doc.getIn(path);
  return isCollection(n) ? n.toJSON() : n;
}

export function parseYaml(text: string): Document {
  const doc = parseDocument(text, { prettyErrors: true });
  if (doc.errors.length > 0) throw new YamlEditError(`invalid YAML: ${doc.errors[0]!.message}`);
  return doc;
}

/**
 * Applies edits; `null` text = file does not exist yet (a new document is created).
 * Returns the original text unchanged when every value already matches.
 */
export function editYaml(text: string | null, edits: readonly YamlEdit[]): { content: string; changed: boolean; created: boolean } {
  const created = text === null || text.trim() === "";
  let src = text ?? "";
  let doc = created ? new Document({}) : parseYaml(src);
  if (!created && doc.contents !== null && !isMap(doc.contents)) throw new YamlEditError("top-level YAML node is not a mapping");

  const pending = edits.filter((e) => !equalValue(valueAt(doc, e.path), e.value));
  if (pending.length === 0) return { content: text ?? "", changed: false, created: false };

  // 1) in-place scalar replacements (descending offsets keep earlier ranges valid)
  const structural: YamlEdit[] = [];
  const splices: Array<{ start: number; end: number; text: string }> = [];
  if (!created) {
    for (const e of pending) {
      const node = doc.getIn(e.path, true);
      if (isScalar(node) && node.range && !Array.isArray(e.value) && node.type !== "BLOCK_FOLDED" && node.type !== "BLOCK_LITERAL") {
        const [start, end] = node.range;
        let rendered = renderScalar(e.value as string | number | boolean | null, node.type);
        if (start === end && src[start - 1] === ":") rendered = ` ${rendered}`;
        splices.push({ start, end, text: rendered });
      } else {
        structural.push(e);
      }
    }
    splices.sort((a, b) => b.start - a.start);
    for (const s of splices) src = src.slice(0, s.start) + s.text + src.slice(s.end);
    doc = parseYaml(src);
  } else {
    structural.push(...pending);
  }

  // 2) structural edits through the Document API
  if (structural.length > 0) {
    for (const e of structural) {
      const v = Array.isArray(e.value) ? doc.createNode([...e.value]) : e.value;
      doc.setIn(e.path, v);
    }
    src = doc.toString({ lineWidth: 0, indentSeq: created ? false : detectIndentSeq(src) });
    doc = parseYaml(src);
  }

  for (const e of edits) {
    if (!equalValue(valueAt(doc, e.path), e.value)) throw new YamlEditError(`edit of ${e.path.join(".")} did not apply`);
  }
  return { content: src, changed: true, created };
}

/** Replaces scalar values at `paths` (and every item of sequences there) with `mask`, in place. */
export function maskYamlPaths(text: string, paths: readonly (readonly (string | number)[])[], mask: string): string {
  const doc = parseYaml(text);
  const splices: Array<{ start: number; end: number; text: string }> = [];
  const maskNode = (node: unknown) => {
    if (isScalar(node) && node.range && node.value !== null && node.value !== "") {
      splices.push({ start: node.range[0], end: node.range[1], text: renderScalar(mask, node.type === "PLAIN" ? "QUOTE_SINGLE" : node.type) });
    } else if (isSeq(node)) {
      for (const item of node.items) maskNode(item);
    }
  };
  for (const p of paths) maskNode(doc.getIn(p, true));
  splices.sort((a, b) => b.start - a.start);
  let out = text;
  for (const s of splices) out = out.slice(0, s.start) + s.text + out.slice(s.end);
  return out;
}
