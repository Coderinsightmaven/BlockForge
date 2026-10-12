import type { Logger } from "pino";

/**
 * Runs an async task periodically without overlapping runs. Errors are logged, never thrown.
 * `runNow()` lets tests and callers trigger a run deterministically.
 */
export class PeriodicTask {
  private timer: NodeJS.Timeout | null = null;
  private running: Promise<void> | null = null;

  constructor(
    private readonly name: string,
    private readonly intervalMs: number,
    private readonly task: () => Promise<void>,
    private readonly logger: Logger,
  ) {}

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => void this.runNow(), this.intervalMs);
    this.timer.unref();
  }

  runNow(): Promise<void> {
    if (this.running) return this.running;
    this.running = (async () => {
      try {
        await this.task();
      } catch (err) {
        this.logger.error({ err, task: this.name }, "periodic task failed");
      } finally {
        this.running = null;
      }
    })();
    return this.running;
  }

  async stop(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    if (this.running) await this.running;
  }
}
