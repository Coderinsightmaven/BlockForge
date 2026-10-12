/**
 * Line diff (Myers' O((N+M)·D) algorithm, "An O(ND) Difference Algorithm and Its Variations",
 * 1986) and a unified-diff formatter compatible with `diff -u` / `git diff` output.
 */

export type DiffOp = { op: "equal" | "delete" | "insert"; text: string };

export function diffLines(a: readonly string[], b: readonly string[]): DiffOp[] {
  // Trim common prefix/suffix first (cheap and keeps D small for typical config edits).
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start++;
  let endA = a.length;
  let endB = b.length;
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) {
    endA--;
    endB--;
  }
  const A = a.slice(start, endA);
  const B = b.slice(start, endB);
  const N = A.length;
  const M = B.length;
  const max = N + M;
  const offset = max;
  const v = new Int32Array(2 * max + 2).fill(-1);
  v[offset + 1] = 0;
  const trace: Int32Array[] = [];
  let found = max === 0;
  for (let d = 0; d <= max && !found; d++) {
    trace.push(v.slice());
    for (let k = -d; k <= d; k += 2) {
      let x: number;
      if (k === -d || (k !== d && v[offset + k - 1]! < v[offset + k + 1]!)) x = v[offset + k + 1]!;
      else x = v[offset + k - 1]! + 1;
      let y = x - k;
      while (x < N && y < M && A[x] === B[y]) {
        x++;
        y++;
      }
      v[offset + k] = x;
      if (x >= N && y >= M) {
        found = true;
        break;
      }
    }
  }
  // Backtrack.
  const middle: DiffOp[] = [];
  let x = N;
  let y = M;
  for (let d = trace.length - 1; d >= 0 && (x > 0 || y > 0); d--) {
    const vd = trace[d]!;
    const k = x - y;
    let prevK: number;
    if (k === -d || (k !== d && vd[offset + k - 1]! < vd[offset + k + 1]!)) prevK = k + 1;
    else prevK = k - 1;
    const prevX = vd[offset + prevK]!;
    const prevY = prevX - prevK;
    while (x > prevX && y > prevY) {
      middle.push({ op: "equal", text: A[x - 1]! });
      x--;
      y--;
    }
    if (d > 0) {
      if (x === prevX) middle.push({ op: "insert", text: B[y - 1]! });
      else middle.push({ op: "delete", text: A[x - 1]! });
    }
    x = prevX;
    y = prevY;
  }
  middle.reverse();
  return [
    ...a.slice(0, start).map((text): DiffOp => ({ op: "equal", text })),
    ...middle,
    ...a.slice(endA).map((text): DiffOp => ({ op: "equal", text })),
  ];
}

function splitForDiff(text: string): { lines: string[]; trailingNewline: boolean } {
  if (text === "") return { lines: [], trailingNewline: true };
  const trailingNewline = text.endsWith("\n");
  const lines = (trailingNewline ? text.slice(0, -1) : text).split("\n");
  return { lines, trailingNewline };
}

export interface UnifiedDiffOptions {
  oldPath?: string;
  newPath?: string;
  context?: number;
  /** Treat the old side as a missing file (`--- /dev/null`). */
  oldMissing?: boolean;
}

/** Unified diff of two texts; empty string when they are identical. */
export function unifiedDiff(oldText: string, newText: string, opts: UnifiedDiffOptions = {}): string {
  if (oldText === newText && !opts.oldMissing) return "";
  const context = opts.context ?? 3;
  const a = splitForDiff(oldText);
  const b = splitForDiff(newText);
  // Model "no newline at end of file" as a distinct last line so it shows up as a change.
  const NO_EOL = "\u0000\\ No newline at end of file";
  const al = [...a.lines];
  const bl = [...b.lines];
  if (!a.trailingNewline && al.length > 0) al[al.length - 1] += NO_EOL;
  if (!b.trailingNewline && bl.length > 0) bl[bl.length - 1] += NO_EOL;
  const ops = diffLines(al, bl);

  // Assign line numbers.
  type Row = DiffOp & { aLine: number; bLine: number };
  const rows: Row[] = [];
  let ai = 0;
  let bi = 0;
  for (const op of ops) {
    rows.push({ ...op, aLine: ai, bLine: bi });
    if (op.op !== "insert") ai++;
    if (op.op !== "delete") bi++;
  }
  const changeIdx = rows.map((r, i) => (r.op === "equal" ? -1 : i)).filter((i) => i >= 0);
  if (changeIdx.length === 0) return "";

  const hunks: Array<[number, number]> = [];
  for (const i of changeIdx) {
    const s = Math.max(0, i - context);
    const e = Math.min(rows.length - 1, i + context);
    const last = hunks[hunks.length - 1];
    if (last && s <= last[1] + 1) last[1] = Math.max(last[1], e);
    else hunks.push([s, e]);
  }

  const render = (r: Row) => {
    const prefix = r.op === "equal" ? " " : r.op === "delete" ? "-" : "+";
    const i = r.text.indexOf(NO_EOL);
    return i >= 0 ? `${prefix}${r.text.slice(0, i)}\n\\ No newline at end of file\n` : `${prefix}${r.text}\n`;
  };
  let out = `--- ${opts.oldMissing ? "/dev/null" : `a/${opts.oldPath ?? "file"}`}\n+++ b/${opts.newPath ?? opts.oldPath ?? "file"}\n`;
  for (const [s, e] of hunks) {
    const slice = rows.slice(s, e + 1);
    const aCount = slice.filter((r) => r.op !== "insert").length;
    const bCount = slice.filter((r) => r.op !== "delete").length;
    const aStart = aCount === 0 ? slice[0]!.aLine : slice[0]!.aLine + 1;
    const bStart = bCount === 0 ? slice[0]!.bLine : slice[0]!.bLine + 1;
    out += `@@ -${aStart}${aCount === 1 ? "" : `,${aCount}`} +${bStart}${bCount === 1 ? "" : `,${bCount}`} @@\n`;
    for (const r of slice) out += render(r);
  }
  return out;
}
