import type { Checksum, ServerSoftware, SoftwareBuild, SoftwareInfo, SoftwareVersion } from "@blockforge/contracts";
import { CatalogError } from "../errors.js";
import type { CatalogContext } from "../http.js";
import type { JavaSource } from "../java.js";

/**
 * Checksum algorithms published upstream. `md5` is NOT in the contracts `Checksum` enum (Purpur
 * only publishes MD5) — see the "contract change requests" in the package README.
 */
export type ChecksumAlgorithm = "md5" | "sha1" | "sha256" | "sha512";

export interface ArtifactChecksum {
  algorithm: ChecksumAlgorithm;
  value: string;
}

export type DownloadRole = "server" | "installer" | "launcher" | "vanilla-server";

export interface ArtifactDownload {
  role: DownloadRole;
  /** HTTPS URL. */
  url: string;
  /** Destination relative to the workload data root (`/data` in the container). */
  destPath: string;
  /** Strongest checksum the upstream publishes (may be MD5), or null. */
  checksum: ArtifactChecksum | null;
  /** Checksum usable by the agent's `artifact.fetch` (sha1/sha256/sha512), or null. */
  agentChecksum: Checksum | null;
  sizeBytes: number | null;
  /** Human-readable statement of where the file and its checksum come from. */
  provenance: string;
}

/** How the JVM is pointed at the server after installation. */
export type LaunchTarget =
  /** `java <jvm…> -jar <jar> <programArgs…>` */
  | { kind: "jar"; jar: string; programArgs: string[] }
  /** `java <jvm…> @<argFile> <programArgs…>` (Forge ≥ 1.17, NeoForge). */
  | { kind: "argfile"; argFile: string; programArgs: string[] }
  /**
   * Legacy Forge installers write one of several jar names; the control plane must `fs.stat` the
   * candidates after installation and launch the first that exists.
   */
  | { kind: "jar-candidates"; candidates: string[]; programArgs: string[] };

export type InstallPlan =
  | { kind: "none" }
  | {
      kind: "installer";
      /** argv after `java` for a one-shot container run in the data root, e.g. `["-jar","installer.jar","--installServer"]`. */
      javaArgs: string[];
      /** Paths (relative) that must exist after a successful install. */
      expects: string[];
      /** Paths safe to delete after a successful install. */
      cleanup: string[];
      /** The installer downloads libraries / the vanilla jar itself (container needs outbound HTTPS). */
      requiresNetwork: boolean;
      notes: string[];
    };

export interface ResolvedArtifact {
  software: ServerSoftware;
  /** Minecraft version (for Velocity: the Velocity version). */
  version: string;
  build: string;
  channel: SoftwareBuild["channel"];
  releasedAt: number | null;
  downloads: ArtifactDownload[];
  java: { major: number; source: JavaSource; notes: string[] };
  install: InstallPlan;
  launch: LaunchTarget;
  /** True when the server itself downloads files on first start (Paperclip, Fabric launcher). */
  requiresNetworkAtFirstStart: boolean;
  /** JVM flags recommended by the upstream for this version (Fill API), if any. */
  recommendedJvmFlags: string[] | null;
  provenance: string;
  notes: string[];
}

export type SupportStatus = "supported" | "deprecated" | "unsupported";

/** Contract `SoftwareVersion` plus catalogue metadata not (yet) in the contract. */
export interface CatalogVersion extends SoftwareVersion {
  /** Where `javaMajor` came from (listing usually uses the documented table). */
  javaSource: JavaSource | null;
  support: SupportStatus | null;
  notes: string[];
}

export interface SoftwareAdapter {
  readonly info: SoftwareInfo;
  /** Versions, newest first. */
  listVersions(ctx: CatalogContext): Promise<CatalogVersion[]>;
  /** Builds for one version, newest first. */
  listBuilds(ctx: CatalogContext, version: string): Promise<SoftwareBuild[]>;
  /** Resolves a build (`null` = latest stable, falling back to latest) into a provisioning plan. */
  resolve(ctx: CatalogContext, version: string, build: string | null): Promise<ResolvedArtifact>;
}

export function toAgentChecksum(c: ArtifactChecksum | null): Checksum | null {
  if (!c || c.algorithm === "md5") return null;
  return { algorithm: c.algorithm, value: c.value.toLowerCase() };
}

/**
 * Validates a caller-supplied version/build token before it is used in a URL path segment.
 * Returns the URL-encoded segment.
 */
export function safeSegment(kind: "version" | "build", value: string): string {
  if (!/^[A-Za-z0-9][A-Za-z0-9._+\- ]{0,63}$/.test(value) || value.includes("..")) {
    throw new CatalogError("INVALID_ARGUMENT", `invalid ${kind}: ${JSON.stringify(value)}`);
  }
  return encodeURIComponent(value);
}
