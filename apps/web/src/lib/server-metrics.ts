import type { Server, WorkloadMetricSample } from "@blockforge/contracts";
import { formatCores, formatPercent, percentOf } from "./format";

/**
 * Workload `cpuPct` is relative to ONE core (200 = two full cores, like `docker stats`).
 * With a CPU limit it is shown as a share of that limit; without one, as cores in use.
 */
export interface CpuView {
  /** 0–100+ share of the CPU limit, or null when the server has no limit. */
  pctOfLimit: number | null;
  cores: number | null;
  limitCores: number | null;
  /** Short display text, e.g. "45% of 2 cores" or "1.2 cores". */
  text: string;
}

export function cpuView(
  sample: Pick<WorkloadMetricSample, "cpuPct"> | null | undefined,
  cpuLimitMillicores: number | null,
): CpuView {
  const limitCores = cpuLimitMillicores ? cpuLimitMillicores / 1000 : null;
  const cpuPct = sample?.cpuPct;
  if (cpuPct === undefined || cpuPct === null) {
    return { pctOfLimit: null, cores: null, limitCores, text: "No data" };
  }
  const cores = cpuPct / 100;
  if (limitCores) {
    const pct = (cores / limitCores) * 100;
    return {
      pctOfLimit: pct,
      cores,
      limitCores,
      text: `${formatPercent(pct, 0)} of ${formatCores(limitCores)}`,
    };
  }
  return {
    pctOfLimit: null,
    cores,
    limitCores: null,
    text: `${formatCores(Math.round(cores * 100) / 100)} (no limit)`,
  };
}

export interface MemoryView {
  used: number | null;
  limit: number;
  pct: number | null;
}

export function memoryView(server: Pick<Server, "memoryLimitBytes" | "latest">): MemoryView {
  const used = server.latest?.memoryUsageBytes ?? null;
  const limit = server.latest?.memoryLimitBytes ?? server.memoryLimitBytes;
  return { used, limit, pct: percentOf(used, limit) };
}

export function diskView(server: Pick<Server, "storageQuotaBytes" | "latest">): {
  used: number | null;
  quota: number | null;
  pct: number | null;
} {
  const used = server.latest?.diskUsageBytes ?? null;
  return { used, quota: server.storageQuotaBytes, pct: percentOf(used, server.storageQuotaBytes) };
}

export function playersView(server: Pick<Server, "game" | "latest">): { online: number; max: number } | null {
  if (server.game === "other") return null;
  const mc = server.latest?.minecraft;
  return mc ? { online: mc.playersOnline, max: mc.playersMax } : null;
}

/** Sample older than this (agents report every ~10 s) is shown as stale. */
export const STALE_SERVER_SAMPLE_MS = 60_000;
