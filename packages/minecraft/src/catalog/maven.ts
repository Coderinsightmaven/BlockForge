import { CatalogError } from "../errors.js";
import { type CatalogContext, getText, parseChecksumFile } from "../http.js";
import type { ArtifactChecksum } from "./types.js";

/**
 * Fetches the strongest checksum sidecar Maven publishes for an artifact. Forge and NeoForge
 * Mavens publish `.sha512`, `.sha256`, `.sha1` and `.md5` for installer jars (verified
 * 2026-10-11). SHA-256 is preferred (it is what the agent reports back), then SHA-512, SHA-1.
 * Returns null only when no sidecar exists.
 */
export async function fetchMavenChecksum(ctx: CatalogContext, artifactUrl: string): Promise<ArtifactChecksum | null> {
  const order: Array<[ArtifactChecksum["algorithm"], number]> = [
    ["sha256", 64],
    ["sha512", 128],
    ["sha1", 40],
  ];
  for (const [algorithm, len] of order) {
    try {
      const text = await getText(ctx, `${artifactUrl}.${algorithm}`, "text/plain");
      const value = parseChecksumFile(text, len);
      if (value) return { algorithm, value };
      throw new CatalogError("INVALID_UPSTREAM_RESPONSE", `malformed ${algorithm} sidecar for ${artifactUrl}`);
    } catch (e) {
      if (e instanceof CatalogError && e.code === "NOT_FOUND") continue;
      throw e;
    }
  }
  return null;
}

/** Numeric-aware comparison of dotted versions with optional `-suffix` (suffix sorts lower). */
export function compareDotted(a: string, b: string): number {
  const split = (v: string) => {
    const i = v.indexOf("-");
    const core = i === -1 ? v : v.slice(0, i);
    const suffix = i === -1 ? "" : v.slice(i + 1);
    return { nums: core.split(".").map((p) => (/^\d+$/.test(p) ? Number(p) : -1)), suffix };
  };
  const x = split(a);
  const y = split(b);
  for (let i = 0; i < Math.max(x.nums.length, y.nums.length); i++) {
    const d = (x.nums[i] ?? -1) - (y.nums[i] ?? -1);
    if (d !== 0) return d < 0 ? -1 : 1;
  }
  if (x.suffix === y.suffix) return 0;
  if (x.suffix === "") return 1;
  if (y.suffix === "") return -1;
  return x.suffix < y.suffix ? -1 : 1;
}
