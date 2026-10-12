import type { Db, Tx } from "./client.js";

/** Callbacks that must only run once the surrounding transaction has committed (event dispatch, realtime). */
export class AfterCommit {
  private readonly fns: (() => unknown)[] = [];

  add(fn: () => unknown): void {
    this.fns.push(fn);
  }

  run(onError: (err: unknown) => void): void {
    for (const fn of this.fns) {
      try {
        const r = fn();
        if (r instanceof Promise) r.catch(onError);
      } catch (err) {
        onError(err);
      }
    }
  }
}

export async function withTransaction<T>(
  db: Db,
  fn: (tx: Tx, after: AfterCommit) => Promise<T>,
  onAfterCommitError: (err: unknown) => void = () => undefined,
): Promise<T> {
  const after = new AfterCommit();
  const result = await db.transaction((tx) => fn(tx, after));
  after.run(onAfterCommitError);
  return result;
}
