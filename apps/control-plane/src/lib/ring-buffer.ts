/** Fixed-capacity FIFO; pushing beyond capacity overwrites the oldest entries. */
export class RingBuffer<T> {
  private readonly items: (T | undefined)[];
  private start = 0;
  private length = 0;

  constructor(readonly capacity: number) {
    if (!Number.isInteger(capacity) || capacity <= 0) throw new Error("capacity must be a positive integer");
    this.items = new Array<T | undefined>(capacity);
  }

  get size(): number {
    return this.length;
  }

  push(item: T): void {
    const idx = (this.start + this.length) % this.capacity;
    this.items[idx] = item;
    if (this.length < this.capacity) this.length++;
    else this.start = (this.start + 1) % this.capacity;
  }

  /** Oldest → newest. */
  toArray(): T[] {
    const out: T[] = [];
    for (let i = 0; i < this.length; i++) out.push(this.items[(this.start + i) % this.capacity] as T);
    return out;
  }

  /** The newest `n` entries, oldest first. */
  tail(n: number): T[] {
    const all = this.toArray();
    return n >= all.length ? all : all.slice(all.length - n);
  }
}
