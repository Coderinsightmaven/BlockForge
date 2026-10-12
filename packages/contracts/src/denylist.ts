/**
 * Template `fileDenylist` semantics, shared by the control plane (file manager) and the node agent
 * (SFTP, `services/node-agent/internal/sftpd/denylist.go`). Both implementations are tested against
 * `fixtures/denylist.json`.
 *
 * A gitignore subset: `*`, `?`, `[...]` within a segment (Go `path.Match` syntax), `**` across
 * segments; a leading or inner `/` anchors the pattern at the data root, patterns without `/` match
 * any path component; a trailing `/` is ignored; `!` re-allows; `#` starts a comment. A match on a
 * directory covers everything below it. The last matching pattern wins. Malformed globs never match.
 * Denied entries still appear in listings (as in Pterodactyl Wings); reading/writing them is refused.
 *
 * Symlinks (enforced by the agent, which can see them): a path is refused when the requested path, ANY
 * symlink it traverses (including intermediate links of a chain), or its resolved location inside the
 * sandbox is denied; tree operations (recursive delete, rename, copy, compress, extract) also refuse when
 * any entry below the source/destination is denied. The control plane's own check on the requested path
 * is only a fast first layer.
 */

interface DenyRule {
  negate: boolean;
  anchored: boolean;
  segs: string[];
}

export interface Denylist {
  /** `rel`: data-root-relative, "/"-separated; "" or "." is the root (never denied). */
  denied(rel: string): boolean;
}

export function compileDenylist(patterns: readonly string[]): Denylist {
  const rules: DenyRule[] = [];
  for (const raw of patterns) {
    let p = raw.replaceAll("\\", "/").trim();
    if (p === "" || p.startsWith("#")) continue;
    const rule: DenyRule = { negate: false, anchored: false, segs: [] };
    if (p.startsWith("!")) {
      rule.negate = true;
      p = p.slice(1);
    }
    p = p.replace(/\/+$/, "");
    if (p.startsWith("/")) {
      rule.anchored = true;
      p = p.replace(/^\/+/, "");
    } else if (p.includes("/")) {
      rule.anchored = true;
    }
    p = cleanPath(p);
    if (p === "") continue;
    rule.segs = p.split("/");
    rules.push(rule);
  }
  return {
    denied(rel: string): boolean {
      if (rules.length === 0 || rel === "" || rel === ".") return false;
      const segs = rel.split("/");
      let denied = false;
      for (const r of rules) if (ruleMatches(r, segs)) denied = !r.negate;
      return denied;
    },
  };
}

/** Go `strings.TrimPrefix(path.Clean("/"+p), "/")`. */
function cleanPath(p: string): string {
  const out: string[] = [];
  for (const seg of p.split("/")) {
    if (seg === "" || seg === ".") continue;
    if (seg === "..") out.pop();
    else out.push(seg);
  }
  return out.join("/");
}

function ruleMatches(r: DenyRule, segs: string[]): boolean {
  if (!r.anchored) {
    if (r.segs.length === 1 && r.segs[0] !== "**") return segs.some((s) => globMatch(r.segs[0]!, s));
    return prefixMatch(["**", ...r.segs], segs);
  }
  return prefixMatch(r.segs, segs);
}

/** The pattern matches the path or any of its ancestors. */
function prefixMatch(pat: string[], segs: string[]): boolean {
  for (let k = 1; k <= segs.length; k++) if (globSegs(pat, segs.slice(0, k))) return true;
  return false;
}

function globSegs(pat: string[], segs: string[]): boolean {
  if (pat.length === 0) return segs.length === 0;
  if (pat[0] === "**") {
    for (let i = 0; i <= segs.length; i++) if (globSegs(pat.slice(1), segs.slice(i))) return true;
    return false;
  }
  if (segs.length === 0 || !globMatch(pat[0]!, segs[0]!)) return false;
  return globSegs(pat.slice(1), segs.slice(1));
}

// ---------------------------------------------------------------------------
// Go `path.Match` for a single segment (no '/' in name). Malformed patterns never match.

function globMatch(pattern: string, name: string): boolean {
  const p = Array.from(pattern);
  const s = Array.from(name);
  if (!validGlob(p)) return false;
  let pi = 0;
  let si = 0;
  let starP = -1;
  let starS = -1;
  while (si < s.length) {
    if (pi < p.length) {
      const c = p[pi]!;
      if (c === "*") {
        starP = pi++;
        starS = si;
        continue;
      }
      if (c === "?") {
        pi++;
        si++;
        continue;
      }
      if (c === "[") {
        const r = matchClass(p, pi, s[si]!);
        if (r.ok) {
          pi = r.next;
          si++;
          continue;
        }
      } else if (c === "\\") {
        if (p[pi + 1] === s[si]) {
          pi += 2;
          si++;
          continue;
        }
      } else if (c === s[si]) {
        pi++;
        si++;
        continue;
      }
    }
    if (starP >= 0) {
      pi = starP + 1;
      si = ++starS;
      continue;
    }
    return false;
  }
  while (pi < p.length && p[pi] === "*") pi++;
  return pi === p.length;
}

function cp(ch: string): number {
  return ch.codePointAt(0)!;
}

/** Assumes a validated pattern; `i` points at '['. */
function matchClass(p: string[], i: number, ch: string): { ok: boolean; next: number } {
  let j = i + 1;
  let negated = false;
  if (p[j] === "^") {
    negated = true;
    j++;
  }
  let matched = false;
  let n = 0;
  for (;;) {
    if (p[j] === "]" && n > 0) {
      j++;
      break;
    }
    let lo = p[j]!;
    if (lo === "\\") lo = p[++j]!;
    j++;
    let hi = lo;
    if (p[j] === "-") {
      hi = p[++j]!;
      if (hi === "\\") hi = p[++j]!;
      j++;
    }
    if (cp(lo) <= cp(ch) && cp(ch) <= cp(hi)) matched = true;
    n++;
  }
  return { ok: matched !== negated, next: j };
}

function validGlob(p: string[]): boolean {
  const esc = (j: number): number => {
    // Go getEsc: a class bound may not be empty, '-' or ']'.
    if (j >= p.length || p[j] === "-" || p[j] === "]") return -1;
    if (p[j] === "\\") {
      j++;
      if (j >= p.length) return -1;
    }
    return j + 1;
  };
  for (let i = 0; i < p.length; i++) {
    const c = p[i];
    if (c === "\\") {
      if (++i >= p.length) return false;
    } else if (c === "[") {
      let j = i + 1;
      if (p[j] === "^") j++;
      let n = 0;
      for (;;) {
        if (j >= p.length) return false;
        if (p[j] === "]" && n > 0) break;
        j = esc(j);
        if (j < 0) return false;
        if (p[j] === "-") {
          j = esc(j + 1);
          if (j < 0) return false;
        }
        n++;
      }
      i = j;
    }
  }
  return true;
}
