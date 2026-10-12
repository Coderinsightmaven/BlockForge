import { MutableRelativePath, RelativePath } from "@blockforge/contracts";
import { SERVER_TABS } from "@/lib/server-permissions";
import type { ServerTab } from "@/lib/server-permissions";
import type { ServerPageSearch } from "./server-page";

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
    path: path !== undefined && RelativePath.safeParse(path).success ? path : undefined,
    edit: edit !== undefined && MutableRelativePath.safeParse(edit).success ? edit : undefined,
    range: range !== undefined && range.length <= 64 ? range : undefined,
  };
}
