import { z } from "zod";
import { Bytes, EpochMs } from "../common.js";

const Pct = z.number().min(0);
const Rate = z.number().min(0);

/**
 * Host-level sample. Fields a platform cannot provide are omitted, never zero-filled.
 * Rates are computed by the agent over the sampling interval.
 */
export const NodeMetricSample = z.object({
  ts: EpochMs,
  cpu: z.object({
    usagePct: Pct,
    perCorePct: z.array(Pct).optional(),
    load1: z.number().optional(),
    load5: z.number().optional(),
    load15: z.number().optional(),
    iowaitPct: Pct.optional(),
    stealPct: Pct.optional(),
  }),
  memory: z.object({
    totalBytes: Bytes,
    usedBytes: Bytes,
    availableBytes: Bytes,
    cachedBytes: Bytes.optional(),
    buffersBytes: Bytes.optional(),
    swapTotalBytes: Bytes.optional(),
    swapUsedBytes: Bytes.optional(),
  }),
  filesystems: z.array(
    z.object({
      mount: z.string(),
      device: z.string().optional(),
      fsType: z.string().optional(),
      totalBytes: Bytes,
      usedBytes: Bytes,
      freeBytes: Bytes,
      inodesTotal: z.number().int().nonnegative().optional(),
      inodesUsed: z.number().int().nonnegative().optional(),
    }),
  ),
  diskIo: z.array(
    z.object({
      device: z.string(),
      readBytesPerSec: Rate,
      writeBytesPerSec: Rate,
      readOpsPerSec: Rate,
      writeOpsPerSec: Rate,
      busyPct: Pct.optional(),
      avgLatencyMs: z.number().min(0).optional(),
    }),
  ),
  network: z.array(
    z.object({
      iface: z.string(),
      rxBytesPerSec: Rate,
      txBytesPerSec: Rate,
      rxPacketsPerSec: Rate.optional(),
      txPacketsPerSec: Rate.optional(),
      rxErrorsTotal: z.number().int().nonnegative().optional(),
      txErrorsTotal: z.number().int().nonnegative().optional(),
      rxDroppedTotal: z.number().int().nonnegative().optional(),
      txDroppedTotal: z.number().int().nonnegative().optional(),
    }),
  ),
  tcp: z
    .object({ established: z.number().int().nonnegative(), total: z.number().int().nonnegative() })
    .optional(),
});
export type NodeMetricSample = z.infer<typeof NodeMetricSample>;

export const JvmStats = z.object({
  heapUsedBytes: Bytes,
  heapCommittedBytes: Bytes,
  heapMaxBytes: Bytes,
  nonHeapUsedBytes: Bytes.optional(),
  gcCountTotal: z.number().int().nonnegative().optional(),
  gcTimeMsTotal: z.number().int().nonnegative().optional(),
  threads: z.number().int().nonnegative().optional(),
  uptimeMs: z.number().int().nonnegative().optional(),
  /** When the probe file was last written (stale probes are dropped by the agent). */
  sampledAt: EpochMs,
});
export type JvmStats = z.infer<typeof JvmStats>;

export const SlpStatus = z.object({
  versionName: z.string().optional(),
  protocol: z.number().int().optional(),
  playersOnline: z.number().int().nonnegative(),
  playersMax: z.number().int().nonnegative(),
  /** Player sample as reported by the server (may be empty/hidden). Untrusted strings. */
  playerSample: z.array(z.object({ name: z.string(), id: z.string() })).default([]),
  motd: z.string().optional(),
  latencyMs: z.number().min(0),
});
export type SlpStatus = z.infer<typeof SlpStatus>;

export const WorkloadMetricSample = z.object({
  workloadId: z.uuid(),
  ts: EpochMs,
  running: z.boolean(),
  cpuPct: Pct.optional(),
  cpuThrottledPeriodsTotal: z.number().int().nonnegative().optional(),
  memoryUsageBytes: Bytes.optional(),
  memoryLimitBytes: Bytes.optional(),
  memoryCacheBytes: Bytes.optional(),
  netRxBytesPerSec: Rate.optional(),
  netTxBytesPerSec: Rate.optional(),
  blkReadBytesPerSec: Rate.optional(),
  blkWriteBytesPerSec: Rate.optional(),
  pids: z.number().int().nonnegative().optional(),
  /** Size of the workload data directory; refreshed every few minutes, not every sample. */
  diskUsageBytes: Bytes.optional(),
  jvm: JvmStats.optional(),
  minecraft: SlpStatus.optional(),
});
export type WorkloadMetricSample = z.infer<typeof WorkloadMetricSample>;
