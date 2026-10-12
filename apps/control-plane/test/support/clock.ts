import type { Clock } from "../../src/lib/clock.js";

/** Real time plus an adjustable offset, so tests can "skip ahead" without fake timers. */
export class OffsetClock implements Clock {
  offsetMs = 0;
  now(): number {
    return Date.now() + this.offsetMs;
  }
  advance(ms: number): void {
    this.offsetMs += ms;
  }
}
