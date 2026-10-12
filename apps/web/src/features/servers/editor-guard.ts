/*
 * Unsaved-editor guard for the server page. The file editor reports its dirty flag to the page;
 * any navigation that would unmount it (another tab, another file, another page, back/forward)
 * asks the same "Discard unsaved changes?" question as the editor's own Back button.
 */

export interface GuardLocation {
  pathname: string;
  search: unknown;
}

function field(search: unknown, key: string): unknown {
  return search && typeof search === "object" ? (search as Record<string, unknown>)[key] : undefined;
}

/** True when going from `current` to `next` would close the open editor. */
export function leavesEditor(current: GuardLocation, next: GuardLocation): boolean {
  if (current.pathname !== next.pathname) return true;
  return (
    field(current.search, "tab") !== field(next.search, "tab") ||
    field(current.search, "edit") !== field(next.search, "edit")
  );
}

export const DISCARD_PROMPT = "Discard unsaved changes?";

/**
 * Decide whether to block a navigation. Asks only when the editor is dirty and would be left;
 * a confirmed discard clears the flag (the editor unmounts anyway).
 */
export function shouldBlockEditorLeave(
  dirty: { current: boolean },
  current: GuardLocation,
  next: GuardLocation,
  confirm: (message: string) => boolean = (m) => window.confirm(m),
): boolean {
  if (!dirty.current || !leavesEditor(current, next)) return false;
  if (!confirm(DISCARD_PROMPT)) return true;
  dirty.current = false;
  return false;
}
