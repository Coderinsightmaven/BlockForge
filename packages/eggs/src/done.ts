import { MAX_REGEX_INPUT, RegexUnsupportedError, compileLinear, stripAnsiLinear } from "./regex.js";

/**
 * Startup "done" detection (Wings `OutputLineMatcher` + `stripAnsiRegex`): a pattern is a literal
 * substring, or `regex:<expr>` in Go/RE2 syntax (a pattern that fails to compile is matched as
 * literal text after the prefix, like Wings). ANSI escape sequences are always stripped before
 * matching. Lines are untrusted: only the first MAX_REGEX_INPUT (8 KiB) characters are inspected,
 * stripping is a single linear pass, and regexes run on the linear-time RE2 engine.
 */

export function stripAnsi(line: string): string {
  return stripAnsiLinear(line);
}

export function createDoneMatcher(patterns: string[]): (line: string) => boolean {
  const matchers = patterns
    .filter((p) => p.length > 0)
    .map((p): ((s: string) => boolean) => {
      if (p.startsWith("regex:") && p.length > 6) {
        const expr = p.slice(6);
        try {
          const re = compileLinear(expr);
          return (s) => re.test(s);
        } catch (e) {
          if (!(e instanceof RegexUnsupportedError)) throw e;
          return (s) => s.includes(expr);
        }
      }
      return (s) => s.includes(p);
    });
  return (line: string) => {
    if (matchers.length === 0) return false;
    const clean = stripAnsiLinear(line.length > MAX_REGEX_INPUT ? line.slice(0, MAX_REGEX_INPUT) : line);
    return matchers.some((m) => m(clean));
  };
}
