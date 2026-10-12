import { useState } from "react";

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

export interface SyncedForm<S, F> {
  /** The form values (null while there is no source). */
  form: F | null;
  setForm: (next: F | ((prev: F) => F)) => void;
  /** The form differs from the server value it was seeded from. */
  dirty: boolean;
  /** While dirty, the server value changed (another session, a refetch after someone else's save). */
  changedElsewhere: boolean;
  /** Re-seed from the current server value (discard edits), or from `next` (e.g. a save's response). */
  reset: (next?: S) => void;
}

interface State<S, F> {
  form: F | null;
  base: F | null;
  seen: S | undefined;
  key: unknown;
}

/**
 * Form state seeded from server data (a query result, a server DTO). The form follows the server
 * value only while it is pristine, or when the new value equals the edits (e.g. the cache update
 * after a successful save): a background refetch, focus refetch or reconnect invalidation never
 * discards unsaved edits. When the server value changes while the form is dirty, `changedElsewhere`
 * is set so the UI can say so (saving overwrites it; `reset` loads it).
 *
 * `key` identifies the edited entity: a different key (or no source at all) always re-seeds.
 * `source` identity matters: TanStack Query keeps it stable while the data is unchanged.
 */
export function useSyncedForm<S, F>(
  source: S | undefined,
  toForm: (s: S) => F,
  key?: unknown,
): SyncedForm<S, F> {
  const seed = (s: S | undefined) => (s === undefined ? null : toForm(s));
  const [state, setState] = useState<State<S, F>>(() => {
    const f = seed(source);
    return { form: f, base: f, seen: source, key };
  });
  const latest = seed(source);
  if (source !== state.seen || key !== state.key) {
    // Render-phase update (React re-renders before committing): no flash of stale values.
    const dirty = state.form !== null && !same(state.form, state.base);
    const keep = dirty && key === state.key && latest !== null && !same(state.form, latest);
    setState(keep ? { ...state, seen: source } : { form: latest, base: latest, seen: source, key });
  }
  const dirty = state.form !== null && !same(state.form, state.base);
  return {
    form: state.form,
    setForm: (next) =>
      setState((s) =>
        s.form === null
          ? s
          : { ...s, form: typeof next === "function" ? (next as (p: F) => F)(s.form) : next },
      ),
    dirty,
    changedElsewhere: dirty && latest !== null && !same(latest, state.base),
    reset: (next) => {
      const f = next === undefined ? latest : seed(next);
      setState({ form: f, base: f, seen: source, key });
    },
  };
}
