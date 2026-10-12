import type { Logger } from "pino";
import type { Clock } from "../lib/clock.js";
import { errorMessage } from "../lib/errors.js";

export interface VmWriterOptions {
  url: string;
  clock: Clock;
  logger: Logger;
  /** Max bytes buffered (pending + retry) before the oldest lines are dropped. */
  maxQueueBytes?: number;
  /** Max bytes per import request. */
  maxBatchBytes?: number;
  requestTimeoutMs?: number;
  fetchImpl?: typeof fetch;
}

export interface VmWriterStats {
  queuedBytes: number;
  sentLines: number;
  droppedLines: number;
  failedRequests: number;
  lastError: string | null;
  lastSuccessAt: number | null;
}

/**
 * Buffered, non-blocking writer for VictoriaMetrics' Prometheus import endpoint. Agent sockets only
 * call `enqueue` (synchronous, O(1)); `flush` runs on a timer. Failed batches are retried with
 * exponential backoff; when the bounded queue overflows the oldest lines are dropped and counted.
 */
export class VmWriter {
  private readonly queue: string[] = [];
  private queuedBytes = 0;
  private failures = 0;
  private nextAttemptAt = 0;
  private flushing: Promise<void> | null = null;
  readonly stats: VmWriterStats = {
    queuedBytes: 0,
    sentLines: 0,
    droppedLines: 0,
    failedRequests: 0,
    lastError: null,
    lastSuccessAt: null,
  };
  private readonly maxQueueBytes: number;
  private readonly maxBatchBytes: number;
  private readonly timeoutMs: number;
  private readonly fetchImpl: typeof fetch;

  constructor(private readonly opts: VmWriterOptions) {
    this.maxQueueBytes = opts.maxQueueBytes ?? 32 * 1024 * 1024;
    this.maxBatchBytes = opts.maxBatchBytes ?? 1024 * 1024;
    this.timeoutMs = opts.requestTimeoutMs ?? 10_000;
    this.fetchImpl = opts.fetchImpl ?? fetch;
  }

  enqueue(lines: readonly string[]): void {
    for (const line of lines) {
      this.queue.push(line);
      this.queuedBytes += line.length + 1;
    }
    while (this.queuedBytes > this.maxQueueBytes && this.queue.length) {
      const dropped = this.queue.shift() as string;
      this.queuedBytes -= dropped.length + 1;
      this.stats.droppedLines++;
    }
    this.stats.queuedBytes = this.queuedBytes;
  }

  get pendingLines(): number {
    return this.queue.length;
  }

  /** Sends everything queued (respecting backoff unless `force`). Never throws. */
  flush(force = false): Promise<void> {
    if (this.flushing) return this.flushing;
    this.flushing = this.doFlush(force).finally(() => {
      this.flushing = null;
    });
    return this.flushing;
  }

  private async doFlush(force: boolean): Promise<void> {
    while (this.queue.length) {
      if (!force && this.opts.clock.now() < this.nextAttemptAt) return;
      let bytes = 0;
      let count = 0;
      while (count < this.queue.length && bytes < this.maxBatchBytes) {
        bytes += (this.queue[count] as string).length + 1;
        count++;
      }
      const batch = this.queue.slice(0, count);
      try {
        const res = await this.fetchImpl(`${this.opts.url}/api/v1/import/prometheus`, {
          method: "POST",
          headers: { "content-type": "text/plain; version=0.0.4" },
          body: batch.join("\n") + "\n",
          signal: AbortSignal.timeout(this.timeoutMs),
        });
        if (!res.ok) throw new Error(`VictoriaMetrics import returned HTTP ${res.status}`);
        await res.body?.cancel().catch(() => undefined);
        this.queue.splice(0, count);
        this.queuedBytes -= bytes;
        this.stats.sentLines += count;
        this.stats.lastSuccessAt = this.opts.clock.now();
        this.failures = 0;
        this.nextAttemptAt = 0;
      } catch (err) {
        this.failures++;
        this.stats.failedRequests++;
        this.stats.lastError = errorMessage(err);
        this.nextAttemptAt = this.opts.clock.now() + Math.min(30_000, 500 * 2 ** this.failures);
        if (this.failures === 1 || this.failures % 20 === 0) {
          this.opts.logger.warn({ err: this.stats.lastError, queued: this.queue.length }, "metrics import to VictoriaMetrics failed; will retry");
        }
        return;
      } finally {
        this.stats.queuedBytes = this.queuedBytes;
      }
    }
  }
}
