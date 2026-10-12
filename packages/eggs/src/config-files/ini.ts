/**
 * Line-based, format-preserving INI editor with Wings' key syntax (wings/parser/parser.go
 * `parseIniFile`): `key` addresses the section-less part at the top of the file, `section.key`
 * addresses `key` in `[section]` (only the first `.` outside `[...]` splits). Missing keys are added
 * at the end of their section, missing sections at the end of the file. Comments (`;`, `#`),
 * blank lines, separators (`=`/`:` and surrounding spaces) and line endings are preserved.
 * Section and key names are case-sensitive (go-ini default).
 */

interface IniLine {
  text: string;
  eol: string;
}

function split(text: string): IniLine[] {
  const out: IniLine[] = [];
  const re = /([^\r\n]*)(\r\n|\n|\r|$)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    if (m[0] === "" && m.index >= text.length) break;
    out.push({ text: m[1]!, eol: m[2]! });
    if (m[2] === "") break;
  }
  return out;
}

export function iniKeyPath(match: string): { section: string; key: string } {
  let depth = 0;
  for (let i = 0; i < match.length; i++) {
    const c = match[i];
    if (c === "[") depth++;
    else if (c === "]") depth--;
    else if (c === "." && depth === 0) return { section: match.slice(0, i), key: match.slice(i + 1) };
  }
  return { section: "", key: match };
}

const HEADER = /^\s*\[([^\]]*)\]\s*(?:[;#].*)?$/;
const ENTRY = /^(\s*)([^=:;#\s][^=:]*?)(\s*[=:]\s*)(.*)$/;

function parseLines(lines: IniLine[]) {
  const entries: Array<{ line: number; section: string; key: string; indent: string; sep: string; value: string }> = [];
  const sections = new Map<string, { header: number; lastContent: number }>();
  let section = "";
  sections.set("", { header: -1, lastContent: -1 });
  lines.forEach((l, i) => {
    const h = HEADER.exec(l.text);
    if (h) {
      section = h[1]!.trim();
      if (!sections.has(section)) sections.set(section, { header: i, lastContent: i });
      return;
    }
    const t = l.text.trim();
    if (t === "" || t.startsWith(";") || t.startsWith("#")) return;
    const e = ENTRY.exec(l.text);
    if (!e) return;
    sections.get(section)!.lastContent = i;
    entries.push({ line: i, section, key: e[2]!.trim(), indent: e[1]!, sep: e[3]!, value: e[4]! });
  });
  return { entries, sections };
}

export interface IniEdit {
  match: string;
  ifValue: string | null;
  value: string;
}

export function editIni(text: string, edits: readonly IniEdit[]): { text: string; changed: boolean; warnings: string[] } {
  const warnings: string[] = [];
  let lines = split(text);
  const eol = lines.find((l) => l.eol !== "")?.eol ?? "\n";
  let changed = false;
  for (const e of edits) {
    const { section, key } = iniKeyPath(e.match);
    const { entries, sections } = parseLines(lines);
    const hits = entries.filter((x) => x.section === section && x.key === key);
    const sepStyle = entries[0]?.sep ?? "=";
    if (hits.length > 0) {
      for (const h of hits) {
        if (e.ifValue !== null && h.value.trim() !== e.ifValue) continue;
        if (h.value === e.value) continue;
        lines[h.line] = { text: `${h.indent}${h.key}${h.sep}${e.value}`, eol: lines[h.line]!.eol };
        changed = true;
      }
      continue;
    }
    if (e.ifValue !== null) continue;
    const newLine = `${key}${sepStyle.includes("=") ? sepStyle : "="}${e.value}`;
    const sec = sections.get(section);
    if (lines.length > 0 && lines[lines.length - 1]!.eol === "" && lines[lines.length - 1]!.text !== "") {
      lines[lines.length - 1] = { ...lines[lines.length - 1]!, eol };
    }
    if (lines.length > 0 && lines[lines.length - 1]!.text === "" && lines[lines.length - 1]!.eol === "") lines.pop();
    if (sec && (sec.lastContent >= 0 || sec.header >= 0)) {
      const at = Math.max(sec.lastContent, sec.header) + 1;
      lines = [...lines.slice(0, at), { text: newLine, eol }, ...lines.slice(at)];
    } else if (section === "") {
      // no section-less content yet: before the first header (or at the start)
      const firstHeader = lines.findIndex((l) => HEADER.test(l.text));
      const at = firstHeader === -1 ? lines.length : 0;
      lines = [...lines.slice(0, at), { text: newLine, eol }, ...lines.slice(at)];
    } else {
      if (lines.length > 0 && lines[lines.length - 1]!.text.trim() !== "") lines.push({ text: "", eol });
      lines.push({ text: `[${section}]`, eol }, { text: newLine, eol });
    }
    changed = true;
  }
  return { text: changed ? lines.map((l) => l.text + l.eol).join("") : text, changed, warnings };
}

export function getIniValue(text: string, match: string): string | undefined {
  const { section, key } = iniKeyPath(match);
  const { entries } = parseLines(split(text));
  const hits = entries.filter((x) => x.section === section && x.key === key);
  return hits.length > 0 ? hits[hits.length - 1]!.value : undefined;
}
