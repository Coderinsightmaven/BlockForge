import { createElement, lazy } from "react";
import type { ComponentProps, ComponentType, FunctionComponent, LazyExoticComponent } from "react";

/** A code chunk could not be downloaded (network error, or it is gone after a new deployment). */
export class ChunkLoadError extends Error {
  constructor(cause: unknown) {
    super("This part of BlockForge could not be downloaded.", { cause });
    this.name = "ChunkLoadError";
  }
}

export function isChunkLoadError(err: unknown): err is ChunkLoadError {
  return err instanceof ChunkLoadError;
}

/** Lazy components whose chunk failed; `retryFailedChunks` makes them import again. */
const failed = new Set<() => void>();

// Same constraint as React's own `lazy`.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyComponent = ComponentType<any>;

export type RetryableLazy<T extends AnyComponent> = FunctionComponent<ComponentProps<T>> & {
  /** Start the download (page mount, hover/focus of whatever opens it). Never rejects. */
  preload: () => Promise<void>;
};

/**
 * `React.lazy` with two additions:
 *  - a failed import can be retried (React.lazy caches the rejection forever): the failure surfaces
 *    as a `ChunkLoadError` for a `ChunkBoundary`, whose Retry calls `retryFailedChunks()`;
 *  - once the module is in (e.g. preloaded on hover), the component renders without suspending, so
 *    opening it shows no loading flash.
 */
export function retryableLazy<T extends AnyComponent>(load: () => Promise<{ default: T }>): RetryableLazy<T> {
  let loaded: T | null = null;
  // The element type in use. Fixed once chosen (switching types would remount and drop state);
  // reset only after a failure.
  let type: T | LazyExoticComponent<T> | null = null;
  const fetchModule = () =>
    load().then(
      (m) => {
        loaded = m.default;
        return m;
      },
      (err: unknown) => {
        throw new ChunkLoadError(err);
      },
    );
  const reset = () => {
    type = null;
  };
  const Retryable = (props: ComponentProps<T>) => {
    type ??=
      loaded ??
      lazy(() =>
        fetchModule().catch((err: unknown) => {
          failed.add(reset);
          throw err;
        }),
      );
    return createElement(type as AnyComponent, props);
  };
  Retryable.preload = () =>
    fetchModule().then(
      () => undefined,
      () => undefined,
    );
  return Retryable;
}

/**
 * Run `preload` once the browser is idle after the first paint (for small chunks a page is likely
 * to need soon, such as its dialogs). Returns a cleanup for `useEffect`.
 */
export function preloadWhenIdle(preload: () => unknown): () => void {
  if (typeof window.requestIdleCallback === "function") {
    const id = window.requestIdleCallback(() => void preload());
    return () => window.cancelIdleCallback(id);
  }
  const t = setTimeout(() => void preload(), 200);
  return () => clearTimeout(t);
}

/** Forget every failed lazy chunk, so the next render downloads it again. */
export function retryFailedChunks(): void {
  for (const reset of failed) reset();
  failed.clear();
}
