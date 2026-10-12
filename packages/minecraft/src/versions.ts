/**
 * Minecraft version parsing and ordering.
 *
 * Mojang uses several schemes over time (all observed in piston-meta, 2026-10-11):
 *  - legacy releases `1.21.11`, `1.8.9`, `1.21`;
 *  - pre-releases / release candidates `1.21.11-pre5`, `1.21.11-rc3`, `1.13-pre7`, `1.14 Pre-Release 5`;
 *  - year-based releases since 2026 `26.1`, `26.1.2`, `26.3`, with `26.3-rc-3` and `26.4-snapshot-3`;
 *  - weekly snapshots `25w14a`;
 *  - historic ids (`b1.7.3`, `rd-132211`, `a1.0.4`, ...).
 *
 * Ordering is only defined for release-like versions (the first three groups). The Mojang adapter
 * uses manifest order (authoritative) and only other adapters rely on this comparator.
 */

export type VersionStage = "snapshot" | "pre" | "rc" | "release";

export interface ParsedVersion {
  kind: "release-like";
  major: number;
  minor: number;
  patch: number;
  stage: VersionStage;
  /** Number of the pre-release / rc / snapshot (0 for releases). */
  stageNumber: number;
  raw: string;
}

export interface UnparsedVersion {
  kind: "weekly-snapshot" | "other";
  raw: string;
}

const RELEASE_LIKE =
  /^(\d+)\.(\d+)(?:\.(\d+))?(?:(?:-| )(pre|rc|snapshot|Pre-Release|Release Candidate)(?:-| )?(\d+))?$/i;
const WEEKLY = /^\d{2}w\d{2}[a-z~]$/;

const STAGE_ORDER: Record<VersionStage, number> = { snapshot: 0, pre: 1, rc: 2, release: 3 };

export function parseMinecraftVersion(raw: string): ParsedVersion | UnparsedVersion {
  const m = RELEASE_LIKE.exec(raw.trim());
  if (m) {
    const stageWord = (m[4] ?? "").toLowerCase();
    const stage: VersionStage =
      stageWord === ""
        ? "release"
        : stageWord === "rc" || stageWord === "release candidate"
          ? "rc"
          : stageWord === "snapshot"
            ? "snapshot"
            : "pre";
    return {
      kind: "release-like",
      major: Number(m[1]),
      minor: Number(m[2]),
      patch: m[3] === undefined ? 0 : Number(m[3]),
      stage,
      stageNumber: m[5] === undefined ? 0 : Number(m[5]),
      raw,
    };
  }
  return { kind: WEEKLY.test(raw) ? "weekly-snapshot" : "other", raw };
}

function cmpNum(a: number, b: number): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** Compares only major.minor.patch. Returns null when either side is not release-like. */
export function compareBaseVersions(a: string, b: string): number | null {
  const pa = parseMinecraftVersion(a);
  const pb = parseMinecraftVersion(b);
  if (pa.kind !== "release-like" || pb.kind !== "release-like") return null;
  return cmpNum(pa.major, pb.major) || cmpNum(pa.minor, pb.minor) || cmpNum(pa.patch, pb.patch);
}

/**
 * Total order used for sorting (ascending). Release-like versions compare numerically, then by
 * stage (snapshot < pre < rc < release). Weekly snapshots and historic ids sort below every
 * release-like version (their relative position cannot be derived from the id alone) and among
 * themselves by string.
 */
export function compareMinecraftVersions(a: string, b: string): number {
  const pa = parseMinecraftVersion(a);
  const pb = parseMinecraftVersion(b);
  if (pa.kind === "release-like" && pb.kind === "release-like") {
    return (
      cmpNum(pa.major, pb.major) ||
      cmpNum(pa.minor, pb.minor) ||
      cmpNum(pa.patch, pb.patch) ||
      cmpNum(STAGE_ORDER[pa.stage], STAGE_ORDER[pb.stage]) ||
      cmpNum(pa.stageNumber, pb.stageNumber)
    );
  }
  if (pa.kind === "release-like") return 1;
  if (pb.kind === "release-like") return -1;
  return a < b ? -1 : a > b ? 1 : 0;
}

/** Newest first. Does not mutate the input. */
export function sortVersionsDesc<T>(items: readonly T[], key: (item: T) => string): T[] {
  return [...items].sort((x, y) => compareMinecraftVersions(key(y), key(x)));
}

/**
 * `true` when the base (major.minor.patch) of `version` is >= `min`. Pre-releases, release
 * candidates and snapshots of X count as X (behaviour changes normally land before the release).
 * Returns `null` when the version cannot be ordered (weekly snapshots, historic ids).
 */
export function isAtLeast(version: string, min: string): boolean | null {
  const c = compareBaseVersions(version, min);
  return c === null ? null : c >= 0;
}

export function isReleaseVersion(version: string): boolean {
  const p = parseMinecraftVersion(version);
  return p.kind === "release-like" && p.stage === "release";
}

/** Velocity versions (`3.5.1`, `4.2.1-SNAPSHOT`). SNAPSHOT sorts below the release of the same number. */
export function compareSemverLike(a: string, b: string): number {
  const parse = (v: string) => {
    const [core = "", ...rest] = v.split("-");
    const nums = core.split(".").map((n) => (/^\d+$/.test(n) ? Number(n) : 0));
    return { nums, pre: rest.join("-") };
  };
  const pa = parse(a);
  const pb = parse(b);
  for (let i = 0; i < Math.max(pa.nums.length, pb.nums.length); i++) {
    const d = cmpNum(pa.nums[i] ?? 0, pb.nums[i] ?? 0);
    if (d !== 0) return d;
  }
  if (pa.pre === pb.pre) return 0;
  if (pa.pre === "") return 1;
  if (pb.pre === "") return -1;
  return pa.pre < pb.pre ? -1 : 1;
}
