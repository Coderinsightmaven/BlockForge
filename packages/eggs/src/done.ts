/**
 * Startup "done" detection (Wings `OutputLineMatcher` + `stripAnsiRegex`): a pattern is a literal
 * substring, or `regex:<expr>` (a pattern that fails to compile is matched as literal text after
 * the prefix, like Wings). ANSI escape sequences are always stripped before matching — eggs that
 * do not set `strip_ansi` simply never relied on colour codes being present.
 */

// Wings' expression (server/listeners.go), translated to JavaScript.
// eslint-disable-next-line no-control-regex -- matching ESC/BEL control characters is the point
const STRIP_ANSI = /[\u001B\u009B][[\]()#;?]*(?:(?:(?:[a-zA-Z\d]*(?:;[a-zA-Z\d]*)*)?\u0007)|(?:(?:\d{1,4}(?:;\d{0,4})*)?[\dA-PRZcf-ntqry=><~]))/g;

export function stripAnsi(line: string): string {
  return line.replace(STRIP_ANSI, "");
}

export function createDoneMatcher(patterns: string[]): (line: string) => boolean {
  const matchers = patterns
    .filter((p) => p.length > 0)
    .map((p): ((s: string) => boolean) => {
      if (p.startsWith("regex:") && p.length > 6) {
        const expr = p.slice(6);
        try {
          const re = new RegExp(expr.replace(/\(\?P<([A-Za-z_][A-Za-z0-9_]*)>/g, "(?<$1>"));
          return (s) => re.test(s);
        } catch {
          return (s) => s.includes(expr);
        }
      }
      return (s) => s.includes(p);
    });
  return (line: string) => {
    if (matchers.length === 0) return false;
    const clean = stripAnsi(line);
    return matchers.some((m) => m(clean));
  };
}
