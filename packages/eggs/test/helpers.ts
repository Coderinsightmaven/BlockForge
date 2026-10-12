import { readFileSync, readdirSync } from "node:fs";

export function fixture(path: string): string {
  return readFileSync(new URL(`./fixtures/${path}`, import.meta.url), "utf8");
}

export function eggFixture(name: string): Record<string, unknown> {
  return JSON.parse(fixture(`eggs/${name}`)) as Record<string, unknown>;
}

export function allEggFixtures(): string[] {
  return readdirSync(new URL("./fixtures/eggs/", import.meta.url)).filter((f) => f.endsWith(".json"));
}

export const codes = (issues: Array<{ code: string; severity: string }>, severity?: string) =>
  issues.filter((i) => severity === undefined || i.severity === severity).map((i) => i.code);
