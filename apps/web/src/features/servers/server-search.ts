import { SERVER_TABS } from "@/lib/server-permissions";
import type { ServerTab } from "@/lib/server-permissions";
import type { ServerPageSearch } from "./server-page";

/*
 * The contract's `RelativePath` / `MutableRelativePath` rules (packages/contracts agent/commands.ts),
 * spelled out because this module is part of the first-load bundle and importing those schemas pulls
 * in every agent command schema. Pinned to the contract by a parity test.
 */
const SEPARATORS = /[/\\]/;
const ABSOLUTE = /^([/\\]|[a-zA-Z]:)/;
const isRootPath = (p: string) => p.split(SEPARATORS).every((seg) => seg === "" || seg === ".");

export function isRelativePath(p: string): boolean {
  return (
    p.length <= 1024 && !p.includes("\u0000") && !ABSOLUTE.test(p) && !p.split(SEPARATORS).includes("..")
  );
}

export function isMutableRelativePath(p: string): boolean {
  return isRelativePath(p) && !isRootPath(p);
}

const TABS = new Set<string>(SERVER_TABS.map((t) => t.id));

function nonEmpty(v: unknown): string | undefined {
  return typeof v === "string" && v !== "" ? v : undefined;
}

/**
 * The server page's URL search params. `path` and `edit` arrive from links anyone can craft, so
 * they are validated with the same relative-path rules as the API (no absolute paths, no "..", no
 * NUL, ≤ 1024 chars; `edit` must not be the data root) and dropped — not truncated — when invalid.
 */
export function parseServerSearch(search: Record<string, unknown>): ServerPageSearch {
  const tab = nonEmpty(search.tab);
  const path = nonEmpty(search.path);
  const edit = nonEmpty(search.edit);
  const range = nonEmpty(search.range);
  return {
    tab: tab !== undefined && TABS.has(tab) ? (tab as ServerTab) : undefined,
    path: path !== undefined && isRelativePath(path) ? path : undefined,
    edit: edit !== undefined && isMutableRelativePath(edit) ? edit : undefined,
    range: range !== undefined && range.length <= 64 ? range : undefined,
  };
}
