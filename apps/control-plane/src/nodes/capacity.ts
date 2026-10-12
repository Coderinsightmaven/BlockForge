import type { NodeCapacity, NodeFacts } from "@blockforge/contracts";

export const SYSTEM_MEMORY_RESERVE_BYTES = 1024 ** 3;

export interface CapacityOverrides {
  cpuAllocatableMillicores: number | null;
  memoryAllocatableBytes: number | null;
  storageAllocatableBytes: number | null;
  overcommitMemoryRatio: string | number;
}

export interface ReservedTotals {
  cpuMillicores: number;
  memoryBytes: number;
  storageBytes: number;
}

/** The filesystem holding `dataRoot`: the longest mount point that is a path prefix of it. */
export function dataRootFilesystem<T extends { mount: string }>(dataRoot: string, filesystems: readonly T[]): T | null {
  const norm = (p: string) => p.replace(/\\/g, "/").replace(/\/+$/, "") || "/";
  const root = norm(dataRoot).toLowerCase();
  let best: T | null = null;
  let bestLen = -1;
  for (const fs of filesystems) {
    const m = norm(fs.mount).toLowerCase();
    const matches = m === "/" || root === m || root.startsWith(m.endsWith("/") ? m : `${m}/`);
    if (matches && m.length > bestLen) {
      best = fs;
      bestLen = m.length;
    }
  }
  return best;
}

/**
 * Allocatable capacity: admin overrides win; otherwise derived from facts —
 * CPU = logical cores × 1000, memory = total − 1 GiB system reserve, storage = size of the
 * filesystem holding the data root. Unknown facts give 0 (nothing can be placed there yet).
 */
export function computeCapacity(o: CapacityOverrides, facts: NodeFacts | null, reserved: ReservedTotals): NodeCapacity {
  const cpu = o.cpuAllocatableMillicores ?? (facts ? facts.cpuLogicalCores * 1000 : 0);
  const memory = o.memoryAllocatableBytes ?? (facts ? Math.max(0, facts.memoryTotalBytes - SYSTEM_MEMORY_RESERVE_BYTES) : 0);
  const storage = o.storageAllocatableBytes ?? (facts ? (dataRootFilesystem(facts.dataRoot, facts.filesystems)?.totalBytes ?? 0) : 0);
  return {
    cpuAllocatableMillicores: cpu,
    memoryAllocatableBytes: memory,
    storageAllocatableBytes: storage,
    cpuReservedMillicores: reserved.cpuMillicores,
    memoryReservedBytes: reserved.memoryBytes,
    storageReservedBytes: reserved.storageBytes,
    overcommitMemoryRatio: Number(o.overcommitMemoryRatio),
  };
}
