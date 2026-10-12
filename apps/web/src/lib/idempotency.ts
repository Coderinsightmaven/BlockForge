import { useCallback, useRef, useState } from "react";
import { newIdempotencyKey } from "./api/client";
import { isApiError } from "./api/errors";

/*
 * Idempotency keys for job-creating actions (power, reinstall, delete, …). The API replays the
 * original response when the same key arrives again with the same request, so:
 *  - a key is reused for retries of the *same* action until its outcome is known;
 *  - it rotates after success, or after a definitive rejection (the server answered with an error,
 *    so nothing was committed);
 *  - it is kept after an uncertain failure (network error, 5xx) so the retry is a replay, never a
 *    second job;
 *  - changing the request (e.g. "also delete files") must mint a new key, otherwise the server
 *    would see one key with two different bodies.
 */

/** True when the request may have been committed even though no success arrived. */
export function isUncertainFailure(err: unknown): boolean {
  if (!isApiError(err)) return true;
  return err.code === "NETWORK_ERROR" || err.status === 0 || err.status >= 500;
}

export type IdempotencyOutcome = { ok: true } | { ok: false; error: unknown };

/** Pure key registry, one key per action name (e.g. "start", "stop"). */
export class IdempotencyKeys<A extends string = string> {
  private keys = new Map<A, string>();
  private inFlight = new Set<A>();

  constructor(private readonly mint: () => string = newIdempotencyKey) {}

  /** The key for `action`, created on first use. */
  keyFor(action: A): string {
    let k = this.keys.get(action);
    if (!k) {
      k = this.mint();
      this.keys.set(action, k);
    }
    return k;
  }

  /** Mark a send; the key stays fixed until `settle`. */
  sent(action: A): string {
    this.inFlight.add(action);
    return this.keyFor(action);
  }

  /** The request for `action` is waiting for (or retrying) an outcome. */
  isLocked(action: A): boolean {
    return this.inFlight.has(action);
  }

  settle(action: A, outcome: IdempotencyOutcome): void {
    if (!outcome.ok && isUncertainFailure(outcome.error)) return; // keep key + lock: retry replays
    this.inFlight.delete(action);
    this.keys.delete(action);
  }

  /** The request body changed: forget the key (only allowed while nothing is in flight). */
  invalidate(action: A): void {
    if (this.inFlight.has(action)) return;
    this.keys.delete(action);
  }
}

/** React wrapper: re-renders when a lock changes so inputs can be disabled. */
export function useIdempotencyKeys<A extends string = string>() {
  const [registry] = useState(() => new IdempotencyKeys<A>());
  const [, bump] = useState(0);
  const rerender = useRef(() => bump((n) => n + 1));
  const sent = useCallback(
    (action: A) => {
      const k = registry.sent(action);
      rerender.current();
      return k;
    },
    [registry],
  );
  const settle = useCallback(
    (action: A, outcome: IdempotencyOutcome) => {
      registry.settle(action, outcome);
      rerender.current();
    },
    [registry],
  );
  const invalidate = useCallback((action: A) => registry.invalidate(action), [registry]);
  return {
    sent,
    settle,
    invalidate,
    isLocked: (a: A) => registry.isLocked(a),
    keyFor: (a: A) => registry.keyFor(a),
  };
}
