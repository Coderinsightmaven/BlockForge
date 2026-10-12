import { readFileSync } from "node:fs";

export function fixture(name: string): string {
  return readFileSync(new URL(`./fixtures/${name}`, import.meta.url), "utf8");
}

export const DEFAULT_TOML = () => fixture("default-velocity-4.2.0.toml");

/** Lines that differ between two texts with the same number of lines. */
export function changedLines(a: string, b: string): Array<[string, string]> {
  const x = a.split("\n");
  const y = b.split("\n");
  if (x.length !== y.length) throw new Error(`line count changed: ${x.length} → ${y.length}`);
  return x.flatMap((l, i) => (l === y[i] ? [] : [[l, y[i]!] as [string, string]]));
}

export const commentLines = (t: string) => t.split("\n").filter((l) => l.trimStart().startsWith("#"));
