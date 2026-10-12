import type { Node, NodeMetricSample } from "@blockforge/contracts";
import { percentOf } from "@/lib/format";

/** Same rule as `UpdateNodeRequest.tags`. */
export const TAG_PATTERN = /^[a-z0-9][a-z0-9-_.]{0,31}$/;
export const MAX_TAGS = 32;

/** "eu, ssd , fast" → ["eu","ssd","fast"], with per-tag validation errors. */
export function parseTags(input: string): { tags: string[]; error: string | null } {
  const tags = [
    ...new Set(
      input
        .split(/[\s,]+/)
        .map((t) => t.trim().toLowerCase())
        .filter(Boolean),
    ),
  ];
  const bad = tags.filter((t) => !TAG_PATTERN.test(t));
  if (bad.length) {
    return {
      tags,
      error: `Invalid tag${bad.length > 1 ? "s" : ""}: ${bad.join(", ")}. Use lowercase letters, digits, "-", "_" or "." (max 32 characters, starting with a letter or digit).`,
    };
  }
  if (tags.length > MAX_TAGS) return { tags, error: `At most ${MAX_TAGS} tags.` };
  return { tags, error: null };
}

type FsSample = NodeMetricSample["filesystems"][number];

/**
 * The filesystem that holds the agent's data root (longest mount-point prefix of `dataRoot`),
 * falling back to the largest filesystem. This is where server data lives.
 */
export function dataFilesystem(node: Pick<Node, "facts" | "latest">): FsSample | null {
  const fss = node.latest?.filesystems ?? [];
  if (fss.length === 0) return null;
  const root = node.facts?.dataRoot;
  if (root) {
    const norm = (p: string) => p.replace(/\\/g, "/").toLowerCase();
    const r = norm(root);
    const matches = fss
      .filter((f) => {
        const m = norm(f.mount);
        return r === m || r.startsWith(m.endsWith("/") ? m : `${m}/`);
      })
      .sort((a, b) => b.mount.length - a.mount.length);
    if (matches[0]) return matches[0];
  }
  return [...fss].sort((a, b) => b.totalBytes - a.totalBytes)[0] ?? null;
}

export function memoryUsedPct(sample: NodeMetricSample | null | undefined): number | null {
  if (!sample) return null;
  return percentOf(sample.memory.usedBytes, sample.memory.totalBytes);
}

export function fsUsedPct(fs: FsSample | null | undefined): number | null {
  if (!fs) return null;
  return percentOf(fs.usedBytes, fs.totalBytes);
}

/** A sample older than this is shown as stale (agents report every ~10 s). */
export const STALE_SAMPLE_MS = 60_000;

export function isStale(ts: number | null | undefined, now: number = Date.now()): boolean {
  return typeof ts !== "number" || now - ts > STALE_SAMPLE_MS;
}
