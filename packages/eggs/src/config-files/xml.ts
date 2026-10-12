/**
 * Minimal source-preserving XML editor with Wings' semantics (wings/parser/parser.go
 * `parseXmlFile`, etree): `Root.Child.Leaf` addresses elements from the root element; `*` matches
 * any element name; without a wildcard missing elements are created; a value of the form
 * `[attr='value']` sets an attribute, any other value replaces the element's leading text.
 * Unlike Wings (which re-indents the whole document) only the edited ranges change.
 * Comments, CDATA, processing instructions and DOCTYPE are skipped by the tokenizer; entity
 * declarations are not expanded.
 */

export class XmlEditError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "XmlEditError";
  }
}

interface Attr {
  name: string;
  /** Range of the value without quotes. */
  valueStart: number;
  valueEnd: number;
  quote: string;
}

interface El {
  name: string;
  start: number;
  /** Offset of the `>` (or `/` of `/>`) that ends the start tag. */
  openTagEnd: number;
  /** Offset just after the start tag. */
  openEnd: number;
  closeStart: number;
  end: number;
  selfClosing: boolean;
  attrs: Attr[];
  children: El[];
  parent: El | null;
}

const NAME = /[A-Za-z_:][-A-Za-z0-9_:.]*/y;

function parse(text: string): { root: El | null } {
  const stack: El[] = [];
  let root: El | null = null;
  let i = 0;
  const n = text.length;
  const skipTo = (marker: string, from: number) => {
    const j = text.indexOf(marker, from);
    if (j === -1) throw new XmlEditError(`unterminated construct (expected "${marker}")`);
    return j + marker.length;
  };
  while (i < n) {
    const lt = text.indexOf("<", i);
    if (lt === -1) break;
    i = lt;
    if (text.startsWith("<!--", i)) {
      i = skipTo("-->", i + 4);
      continue;
    }
    if (text.startsWith("<![CDATA[", i)) {
      i = skipTo("]]>", i + 9);
      continue;
    }
    if (text.startsWith("<?", i)) {
      i = skipTo("?>", i + 2);
      continue;
    }
    if (text.startsWith("<!", i)) {
      let depth = 0;
      let j = i + 2;
      for (; j < n; j++) {
        if (text[j] === "[") depth++;
        else if (text[j] === "]") depth--;
        else if (text[j] === ">" && depth <= 0) break;
      }
      if (j >= n) throw new XmlEditError("unterminated declaration");
      i = j + 1;
      continue;
    }
    if (text.startsWith("</", i)) {
      NAME.lastIndex = i + 2;
      const m = NAME.exec(text);
      if (!m) throw new XmlEditError("malformed end tag");
      const close = text.indexOf(">", NAME.lastIndex);
      if (close === -1) throw new XmlEditError("unterminated end tag");
      const el = stack.pop();
      if (!el || el.name !== m[0]) throw new XmlEditError(`mismatched end tag </${m[0]}>`);
      el.closeStart = i;
      el.end = close + 1;
      i = close + 1;
      continue;
    }
    NAME.lastIndex = i + 1;
    const m = NAME.exec(text);
    if (!m) {
      i++;
      continue;
    }
    const el: El = { name: m[0], start: i, openTagEnd: -1, openEnd: -1, closeStart: -1, end: -1, selfClosing: false, attrs: [], children: [], parent: stack[stack.length - 1] ?? null };
    let j = NAME.lastIndex;
    for (;;) {
      while (j < n && /\s/.test(text[j]!)) j++;
      if (j >= n) throw new XmlEditError(`unterminated start tag <${el.name}>`);
      if (text[j] === ">") {
        el.openTagEnd = j;
        el.openEnd = j + 1;
        break;
      }
      if (text.startsWith("/>", j)) {
        el.openTagEnd = j;
        el.openEnd = j + 2;
        el.selfClosing = true;
        el.closeStart = j;
        el.end = j + 2;
        break;
      }
      NAME.lastIndex = j;
      const a = NAME.exec(text);
      if (!a) throw new XmlEditError(`malformed attribute in <${el.name}>`);
      j = NAME.lastIndex;
      while (j < n && /\s/.test(text[j]!)) j++;
      if (text[j] !== "=") throw new XmlEditError(`attribute ${a[0]} without value`);
      j++;
      while (j < n && /\s/.test(text[j]!)) j++;
      const q = text[j];
      if (q !== '"' && q !== "'") throw new XmlEditError(`unquoted attribute ${a[0]}`);
      const vEnd = text.indexOf(q, j + 1);
      if (vEnd === -1) throw new XmlEditError(`unterminated attribute ${a[0]}`);
      el.attrs.push({ name: a[0], valueStart: j + 1, valueEnd: vEnd, quote: q });
      j = vEnd + 1;
    }
    if (el.parent) el.parent.children.push(el);
    else if (!root) root = el;
    else throw new XmlEditError("multiple root elements");
    if (!el.selfClosing) stack.push(el);
    i = el.openEnd;
  }
  if (stack.length > 0) throw new XmlEditError(`unclosed element <${stack[stack.length - 1]!.name}>`);
  return { root };
}

export function escapeXmlText(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

export function escapeXmlAttr(s: string, quote: string): string {
  const e = s.replace(/&/g, "&amp;").replace(/</g, "&lt;");
  return quote === '"' ? e.replace(/"/g, "&quot;") : e.replace(/'/g, "&apos;");
}

function unescapeXml(s: string): string {
  return s
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#x([0-9a-fA-F]+);/g, (_, h: string) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d: string) => String.fromCodePoint(Number(d)))
    .replace(/&amp;/g, "&");
}

function findAll(root: El | null, parts: string[]): El[] {
  if (!root || parts.length === 0) return [];
  if (parts[0] !== "*" && parts[0] !== root.name) return [];
  let cur = [root];
  for (const p of parts.slice(1)) cur = cur.flatMap((e) => e.children.filter((c) => p === "*" || c.name === p));
  return cur;
}

function lineIndent(text: string, pos: number): string {
  const ls = text.lastIndexOf("\n", pos - 1) + 1;
  return /^[ \t]*/.exec(text.slice(ls, pos))![0];
}

const ATTR_VALUE = /^\[([\w]+)='(.*)'\]$/;

export interface XmlEdit {
  match: string;
  ifValue: string | null;
  value: string;
}

/** Leading text of an element (unescaped), or the attribute value for `[attr='…']` reads. */
function currentText(text: string, el: El): string {
  if (el.selfClosing) return "";
  const stop = el.children[0]?.start ?? el.closeStart;
  return unescapeXml(text.slice(el.openEnd, stop));
}

export function editXml(input: string, edits: readonly XmlEdit[]): { text: string; changed: boolean; warnings: string[] } {
  let text = input;
  const warnings: string[] = [];
  const eol = /\r\n/.test(text) ? "\r\n" : "\n";
  for (const e of edits) {
    const parts = e.match.split(".");
    if (parts.some((p) => p === "")) {
      warnings.push(`invalid XML path "${e.match}"`);
      continue;
    }
    let { root } = parse(text);
    if (!parts.includes("*") && e.ifValue === null) {
      if (!root) {
        if (parts[0] === "*") continue;
        const sep = text.length > 0 && !text.endsWith("\n") ? eol : "";
        const decl = text.trim() === "" ? `<?xml version="1.0" encoding="utf-8"?>${eol}` : "";
        text = `${text}${sep}${decl}<${parts[0]}></${parts[0]}>${eol}`;
        root = parse(text).root;
      }
      if (root && root.name === parts[0]) {
        // create the missing chain
        let el = root;
        for (const p of parts.slice(1)) {
          const found = el.children.find((c) => c.name === p);
          if (found) {
            el = found;
            continue;
          }
          const parentIndent = lineIndent(text, el.start);
          const childIndent = el.children[0] ? lineIndent(text, el.children[0].start) : `${parentIndent}  `;
          if (el.selfClosing) {
            text = `${text.slice(0, el.openTagEnd).replace(/\s*$/, "")}>${eol}${childIndent}<${p}></${p}>${eol}${parentIndent}</${el.name}>${text.slice(el.end)}`;
          } else {
            const before = text.slice(0, el.closeStart);
            const onOwnLine = /\n[ \t]*$/.test(before);
            const insert = onOwnLine
              ? `${childIndent}<${p}></${p}>${eol}${parentIndent}`
              : `${eol}${childIndent}<${p}></${p}>${eol}${parentIndent}`;
            const trimmedBefore = onOwnLine ? before.replace(/[ \t]*$/, "") : before;
            text = trimmedBefore + insert + text.slice(el.closeStart);
          }
          const reparsed = parse(text).root!;
          el = findAll(reparsed, parts.slice(0, parts.indexOf(p) + 1))[0]!;
        }
        root = parse(text).root;
      }
    }
    const targets = findAll(root, parts);
    // apply from the end so earlier offsets stay valid
    for (const el of [...targets].sort((a, b) => b.start - a.start)) {
      const attr = ATTR_VALUE.exec(e.value);
      if (attr) {
        const [, name, val] = attr;
        const existing = el.attrs.find((a) => a.name === name);
        if (e.ifValue !== null && unescapeXml(existing ? text.slice(existing.valueStart, existing.valueEnd) : "") !== e.ifValue) continue;
        if (existing) {
          const escaped = escapeXmlAttr(val!, existing.quote);
          if (text.slice(existing.valueStart, existing.valueEnd) === escaped) continue;
          text = text.slice(0, existing.valueStart) + escaped + text.slice(existing.valueEnd);
        } else {
          let at = el.openTagEnd;
          while (at > el.start && /\s/.test(text[at - 1]!)) at--;
          text = `${text.slice(0, at)} ${name}="${escapeXmlAttr(val!, '"')}"${text.slice(at)}`;
        }
        continue;
      }
      if (e.ifValue !== null && currentText(text, el).trim() !== e.ifValue) continue;
      const escaped = escapeXmlText(e.value);
      if (el.selfClosing) {
        let at = el.openTagEnd;
        while (at > el.start && /\s/.test(text[at - 1]!)) at--;
        text = `${text.slice(0, at)}>${escaped}</${el.name}>${text.slice(el.end)}`;
      } else {
        const stop = el.children[0]?.start ?? el.closeStart;
        if (el.children.length > 0) {
          warnings.push(`<${el.name}> has child elements; only its leading text was replaced`);
        }
        if (text.slice(el.openEnd, stop) === escaped) continue;
        text = text.slice(0, el.openEnd) + escaped + text.slice(stop);
      }
    }
  }
  return { text, changed: text !== input, warnings };
}

export function getXmlValue(text: string, match: string): string | undefined {
  const el = findAll(parse(text).root, match.split("."))[0];
  return el ? currentText(text, el) : undefined;
}
