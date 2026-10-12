import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

/*
 * The gitignore subset shared by the template file denylist and backup ignore lists
 * (`compileDenylist` in @blockforge/contracts; the agent implements the same matcher).
 */
const EXAMPLES: Array<[string, string]> = [
  ["*.log", "any file ending in .log, in every folder (no “/” = matches a name anywhere)"],
  ["/world/region", "anchored at the server root (a leading or inner “/” anchors)"],
  ["logs/", "a trailing “/” is ignored: same as “logs” — the folder and everything below it"],
  ["**/cache", "“**” spans folders; “*”, “?” and “[abc]” match within one name"],
  ["!logs/latest.log", "“!” brings back a path an earlier line excluded (the last match wins)"],
  ["# comment", "lines starting with “#” are ignored"],
];

/** Collapsible syntax reference for one-pattern-per-line fields. */
export function PatternHelp({ className, extra }: { className?: string; extra?: ReactNode }) {
  return (
    <details className={cn("text-xs text-muted-foreground", className)}>
      <summary className="cursor-pointer select-none hover:text-foreground">
        Pattern syntax (gitignore-style)
      </summary>
      <ul className="mt-1.5 flex flex-col gap-1">
        {EXAMPLES.map(([pattern, meaning]) => (
          <li key={pattern} className="flex flex-wrap gap-x-2">
            <code className="rounded bg-muted px-1 font-mono text-foreground">{pattern}</code>
            <span>{meaning}</span>
          </li>
        ))}
      </ul>
      {extra ? <p className="mt-1.5">{extra}</p> : null}
    </details>
  );
}

/** One entry per non-empty line. */
export function linesToList(s: string): string[] {
  return s
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);
}
