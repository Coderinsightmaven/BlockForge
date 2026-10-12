import type { OverviewSummary } from "@blockforge/contracts";
import type { Logger } from "pino";
import type { Clock } from "../lib/clock.js";
import type { RealtimeHub } from "../realtime/hub.js";
import type { OverviewService } from "./service.js";

const MIN_INTERVAL_MS = 2000;

/**
 * Pushes `overview.updated` to subscribers of the `overview` topic at most once every 2 s. The
 * summary is scope-dependent, so it is computed per distinct user (once per publish).
 */
export class OverviewPublisher {
  private timer: NodeJS.Timeout | null = null;
  private lastPublishAt = 0;
  private stopped = false;

  constructor(
    private readonly hub: RealtimeHub,
    private readonly overview: OverviewService,
    private readonly clock: Clock,
    private readonly logger: Logger,
  ) {}

  markDirty(): void {
    if (this.timer || this.stopped || !this.hub.hasSubscribers("overview")) return;
    const wait = Math.max(0, this.lastPublishAt + MIN_INTERVAL_MS - this.clock.now());
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.publish();
    }, wait);
    this.timer.unref();
  }

  async publish(): Promise<void> {
    this.lastPublishAt = this.clock.now();
    const perUser = new Map<string, Promise<OverviewSummary>>();
    for (const client of this.hub.subscribers("overview")) {
      try {
        let p = perUser.get(client.userId);
        if (!p) {
          p = this.overview.summary(client.principal);
          perUser.set(client.userId, p);
        }
        this.hub.sendTo(client, "overview", "overview.updated", await p);
      } catch (err) {
        this.logger.warn({ err }, "overview publish failed");
      }
    }
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }
}
