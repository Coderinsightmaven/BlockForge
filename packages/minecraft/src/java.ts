import type { ServerSoftware } from "@blockforge/contracts";
import { compareSemverLike, isAtLeast } from "./versions.js";

/**
 * Java requirements.
 *
 * Authoritative source: Mojang per-version metadata `javaVersion.majorVersion`
 * (piston-meta, verified 2026-10-11 across all 103 releases):
 *   1.0 … 1.16.5 → 8 (1.6.x has no javaVersion field), 1.17.x → 16, 1.18 … 1.20.4 → 17,
 *   1.20.5 … 1.21.11 → 21, 26.1 … 26.3 → 25.
 * PaperMC's Fill API v3 also publishes `java.version.minimum` per Paper/Folia/Velocity version;
 * when both are known the higher one wins.
 * The table below is the documented fallback used when no metadata is available (e.g. listing).
 */
export const MINECRAFT_JAVA_TABLE: ReadonlyArray<{ since: string; major: number }> = [
  { since: "26.1", major: 25 },
  { since: "1.20.5", major: 21 },
  { since: "1.18", major: 17 },
  { since: "1.17", major: 16 },
  { since: "0.0", major: 8 },
];

/** Velocity's minimum Java per release line (Fill API `java.version.minimum`, 2026-10-11). */
export const VELOCITY_JAVA_TABLE: ReadonlyArray<{ since: string; major: number }> = [
  { since: "4.0.0", major: 25 },
  { since: "3.5.0", major: 21 },
  { since: "3.3.0", major: 17 },
  { since: "3.0.0", major: 11 },
  { since: "0.0.0", major: 8 },
];

/**
 * Java majors with maintained `eclipse-temurin:<major>-jre` images (Docker Hub, checked
 * 2026-10-11: 8/11/17/21/25 updated 2026-10-02/03). Non-LTS tags (22, 24, …) stop receiving
 * updates once superseded (22-jre last updated 2024-09), and 16-jre was never published, so only
 * LTS majors are used.
 */
export const MAINTAINED_JRE_MAJORS = [8, 11, 17, 21, 25] as const;

export type JavaSource = "upstream" | "mojang" | "table";

export function javaMajorFromTable(software: ServerSoftware, version: string): number {
  if (software === "velocity") {
    for (const row of VELOCITY_JAVA_TABLE) if (compareSemverLike(version, row.since) >= 0) return row.major;
    return 8;
  }
  for (const row of MINECRAFT_JAVA_TABLE) {
    const ok = isAtLeast(version, row.since);
    if (ok === null) return MINECRAFT_JAVA_TABLE[0]!.major; // unknown id (weekly snapshot): assume newest
    if (ok) return row.major;
  }
  return 8;
}

export interface RequiredJava {
  major: number;
  source: JavaSource;
  notes: string[];
}

/**
 * Required Java major for (software, version). `mojangMajor` is Mojang's
 * `javaVersion.majorVersion` for the game version, `upstreamMinimum` the distribution's own
 * minimum (Fill API). Falls back to the documented table.
 */
export function requiredJavaMajor(input: {
  software: ServerSoftware;
  version: string;
  mojangMajor?: number | null;
  upstreamMinimum?: number | null;
}): RequiredJava {
  const notes: string[] = [];
  const m = input.mojangMajor ?? null;
  const u = input.upstreamMinimum ?? null;
  if (m !== null && u !== null) {
    if (u > m) notes.push(`${input.software} requires Java ${u}, newer than Minecraft's own requirement (${m}).`);
    return u >= m ? { major: u, source: "upstream", notes } : { major: m, source: "mojang", notes };
  }
  if (u !== null) return { major: u, source: "upstream", notes };
  if (m !== null) return { major: m, source: "mojang", notes };
  notes.push("Java version derived from BlockForge's documented table (no upstream metadata).");
  return { major: javaMajorFromTable(input.software, input.version), source: "table", notes };
}

/** Smallest maintained JRE major >= required. */
export function runtimeMajorFor(required: number): number {
  for (const m of MAINTAINED_JRE_MAJORS) if (m >= required) return m;
  return required; // newer than any LTS we know: use the exact major
}

export function javaImage(major: number): string {
  if (!Number.isInteger(major) || major < 8 || major > 99) throw new RangeError(`invalid Java major: ${major}`);
  return `eclipse-temurin:${major}-jre`;
}

export interface JavaRuntimeSelection {
  major: number;
  image: string;
  warnings: string[];
  errors: string[];
}

/**
 * Picks the runtime for a server. `overrideMajor` is the user's explicit choice
 * (CreateServerRequest.javaMajor).
 */
export function selectJavaRuntime(input: {
  requiredMajor: number;
  overrideMajor?: number | null;
  software: ServerSoftware;
  minecraftVersion: string;
}): JavaRuntimeSelection {
  const warnings: string[] = [];
  const errors: string[] = [];
  let major = runtimeMajorFor(input.requiredMajor);
  if (input.overrideMajor !== undefined && input.overrideMajor !== null) {
    const o = input.overrideMajor;
    if (o < input.requiredMajor) {
      errors.push(`Java ${o} is too old: ${input.software} ${input.minecraftVersion} requires Java ${input.requiredMajor} or newer.`);
    } else if (!(MAINTAINED_JRE_MAJORS as readonly number[]).includes(o)) {
      warnings.push(`Java ${o} is not a maintained LTS image; eclipse-temurin:${o}-jre may be outdated or missing.`);
    }
    major = o;
  }
  const legacyModded =
    (input.software === "forge" || input.software === "fabric") && isAtLeast(input.minecraftVersion, "1.17") === false;
  if (legacyModded && major > 8) {
    warnings.push(`${input.software} for Minecraft ${input.minecraftVersion} is commonly incompatible with Java newer than 8.`);
  }
  if (major > input.requiredMajor && input.overrideMajor && input.overrideMajor > runtimeMajorFor(input.requiredMajor)) {
    warnings.push(`Java ${major} is newer than required (${input.requiredMajor}); some plugins/mods may not support it.`);
  }
  return { major, image: javaImage(major), warnings, errors };
}

/**
 * Java major that produced a class file version (`UnsupportedClassVersionError` diagnostics):
 * class file 52 = Java 8, 61 = Java 17, 65 = Java 21, 69 = Java 25.
 */
export function javaMajorForClassFileVersion(classFileVersion: number): number {
  return Math.trunc(classFileVersion) - 44;
}
