import {
  AGENT_COMMANDS,
  type CommandPayload,
  type GameplaySettings,
  type PortBinding,
  type RestartPolicy,
  type WorkloadNetwork,
  WorkloadSpec,
  isValidWorkloadSpec,
  softwareKind,
} from "@blockforge/contracts";
import type { z } from "zod";
import type { ResolvedArtifact } from "./catalog/types.js";
import { generateEula } from "./eula.js";
import { type JvmPreset, LaunchValidationError, type LaunchIssue, buildInstallerSpec, buildLaunchSpec } from "./launch.js";
import { gameplayToProperties, platformProperties } from "./properties/gameplay.js";
import { updatePropertiesText } from "./properties/document.js";

/**
 * Everything the control plane's provision job needs for a built-in Minecraft / Velocity server:
 * artifact downloads (agent `artifact.fetch` payloads, content-addressed cache), the one-shot
 * installer (Forge/NeoForge, agent `workload.install`), the `WorkloadSpec`, the files to write
 * and the game-rule commands to run once the server is ready.
 *
 * Networking: every allocation is published TCP + UDP with container port = host port, and the
 * server listens on the primary allocation's port inside its own network namespace
 * (`server-port`, `query.port`; Velocity `bind`).
 */

export interface Allocation {
  ip: string;
  port: number;
}

export interface MinecraftProvisioningInput {
  /** Server id = workload id (UUID). */
  serverId: string;
  artifact: ResolvedArtifact;
  memoryLimitBytes: number;
  heapMaxBytes?: number | null;
  cpuLimitMillicores: number | null;
  pidsLimit?: number;
  jvmPreset: JvmPreset;
  jvmArgs?: readonly string[];
  /** Explicit Java runtime (already validated against the requirement). */
  javaMajor?: number | null;
  primary: Allocation;
  additional?: readonly Allocation[];
  timezone: string;
  restartPolicy: RestartPolicy;
  gameplay?: GameplaySettings;
  /** Mojang EULA accepted by the requesting user (required for game servers). */
  acceptEula: boolean;
  acceptedAt?: Date;
  acceptedBy?: string;
  /** Current file contents (null/absent = file does not exist), so edits preserve user changes. */
  currentFiles?: { "server.properties"?: string | null; "velocity.toml"?: string | null };
  /** Installed jar for legacy Forge (`jar-candidates` launch targets), after installation. */
  launchJar?: string | null;
  networks?: Array<z.input<typeof WorkloadNetwork>>;
  labels?: Record<string, string>;
}

export type ArtifactFetchPayload = CommandPayload<"artifact.fetch">;
export type WorkloadInstallPayload = CommandPayload<"workload.install">;

export interface MinecraftProvisioning {
  downloads: ArtifactFetchPayload[];
  /** One-shot installer (Forge/NeoForge) or null. Run before the first start, with outbound HTTPS. */
  install: {
    javaArgs: string[];
    image: string;
    /** Ready-to-send `workload.install` payload (sh script running the installer in /mnt/server). */
    payload: WorkloadInstallPayload;
    expects: string[];
    cleanup: string[];
  } | null;
  workload: WorkloadSpec;
  files: Array<{ path: string; content: string }>;
  /** Files that cannot be written yet, with the reason (e.g. velocity.toml before the first start). */
  deferredFiles: Array<{ path: string; reason: string }>;
  /** Console commands (no leading slash) to run once the server reports ready. */
  gamerules: string[];
  warnings: string[];
}

export class ProvisioningError extends Error {
  readonly issues: string[];
  constructor(issues: string[]) {
    super(issues.join("; "));
    this.name = "ProvisioningError";
    this.issues = issues;
  }
}

const MiB = 1024 * 1024;
/** Upper bound for downloads whose size the upstream does not publish. */
export const DEFAULT_MAX_DOWNLOAD_BYTES = 512 * MiB;
/** Forge/NeoForge installers download ~200 MB and patch the server; slow disks need time. */
export const INSTALLER_TIMEOUT_MS = 45 * 60_000;

function shellQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

/** Sets `bind` in the root table of velocity.toml (line-level edit; everything else is kept). */
export function setVelocityBind(toml: string, bind: string): { content: string; changed: boolean } {
  const lines = toml.split(/(?<=\n)/);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    if (/^\s*\[/.test(line)) break; // only the root table
    const m = /^(\s*bind\s*=\s*)"[^"\\]*"(.*?)(\r?\n)?$/.exec(line);
    if (m) {
      const next = `${m[1]}"${bind}"${m[2]}${m[3] ?? ""}`;
      if (next === line) return { content: toml, changed: false };
      lines[i] = next;
      return { content: lines.join(""), changed: true };
    }
  }
  throw new ProvisioningError(["velocity.toml has no root-level `bind` entry to update"]);
}

function ports(primary: Allocation, additional: readonly Allocation[]): PortBinding[] {
  const out: PortBinding[] = [];
  const seen = new Set<string>();
  for (const a of [primary, ...additional]) {
    const key = `${a.ip}:${a.port}`;
    if (seen.has(key)) throw new ProvisioningError([`allocation ${key} is listed twice`]);
    seen.add(key);
    for (const protocol of ["tcp", "udp"] as const) out.push({ containerPort: a.port, hostPort: a.port, hostIp: a.ip, protocol });
  }
  if (out.length > 16) throw new ProvisioningError(["at most 8 allocations can be published (16 port bindings)"]);
  return out;
}

export function buildMinecraftProvisioning(input: MinecraftProvisioningInput): MinecraftProvisioning {
  const a = input.artifact;
  const warnings: string[] = [];
  const isProxy = softwareKind(a.software) === "proxy";
  if (!isProxy && !input.acceptEula) throw new ProvisioningError(["the Minecraft EULA must be accepted before a game server can be provisioned"]);

  // --- downloads ---------------------------------------------------------------------------
  const downloads: ArtifactFetchPayload[] = a.downloads.map((d) => {
    if (!d.agentChecksum) {
      warnings.push(`${d.destPath} has no checksum the agent can verify (${d.checksum ? `${d.checksum.algorithm} only` : "none published"}); it is not cached and relies on HTTPS transport integrity.`);
    }
    return {
      workloadId: input.serverId,
      url: d.url,
      destPath: d.destPath,
      checksum: d.agentChecksum,
      maxBytes: d.sizeBytes !== null ? d.sizeBytes : DEFAULT_MAX_DOWNLOAD_BYTES,
      cache: true,
    };
  });
  for (const p of downloads) AGENT_COMMANDS["artifact.fetch"].payload.parse(p);

  // --- launch ------------------------------------------------------------------------------
  let launch;
  try {
    launch = buildLaunchSpec({
      software: a.software,
      artifact: a,
      javaMajor: input.javaMajor ?? null,
      memoryLimitBytes: input.memoryLimitBytes,
      heapMaxBytes: input.heapMaxBytes ?? null,
      jvmPreset: input.jvmPreset,
      extraJvmArgs: input.jvmArgs ?? [],
      launchJar: input.launchJar ?? null,
      timezone: input.timezone,
    });
  } catch (e) {
    if (e instanceof LaunchValidationError) throw new ProvisioningError(e.issues.filter((i: LaunchIssue) => i.severity === "error").map((i) => i.message));
    throw e;
  }
  warnings.push(...launch.warnings.map((w) => w.message));

  // --- installer ---------------------------------------------------------------------------
  let install: MinecraftProvisioning["install"] = null;
  if (a.install.kind === "installer") {
    const spec = buildInstallerSpec(a, { memoryLimitBytes: input.memoryLimitBytes, javaMajor: launch.javaMajor });
    if (spec) {
      const javaArgs = spec.command.slice(1);
      const script = ["#!/bin/sh", "set -e", "cd /mnt/server", `exec java ${javaArgs.map(shellQuote).join(" ")}`, ""].join("\n");
      const payload: WorkloadInstallPayload = {
        workloadId: input.serverId,
        image: spec.image,
        entrypoint: "sh",
        script,
        env: {},
        memoryLimitBytes: input.memoryLimitBytes,
        cpuLimitMillicores: input.cpuLimitMillicores,
        timeoutMs: INSTALLER_TIMEOUT_MS,
      };
      AGENT_COMMANDS["workload.install"].payload.parse(payload);
      install = { javaArgs, image: spec.image, payload, expects: a.install.expects, cleanup: a.install.cleanup };
    }
  }

  // --- workload ----------------------------------------------------------------------------
  const additional = input.additional ?? [];
  const workload = WorkloadSpec.parse({
    workloadId: input.serverId,
    kind: isProxy ? "velocity" : "minecraft",
    image: launch.image,
    entrypoint: "argv",
    command: launch.command,
    env: launch.env,
    dataMountPath: "/data",
    readOnlyRootfs: true,
    memoryLimitBytes: input.memoryLimitBytes,
    cpuLimitMillicores: input.cpuLimitMillicores,
    ...(input.pidsLimit !== undefined ? { pidsLimit: input.pidsLimit } : {}),
    ports: ports(input.primary, additional),
    networks: input.networks ?? [],
    stop: launch.stop,
    stopTimeoutMs: isProxy ? 30_000 : 120_000,
    restartPolicy: input.restartPolicy,
    jvmProbe: true,
    labels: { "blockforge.software": a.software, "blockforge.version": a.version.toLowerCase().replace(/[^a-z0-9.\-/]/g, "-").slice(0, 128), ...(input.labels ?? {}) },
  });
  if (!isValidWorkloadSpec(workload)) throw new ProvisioningError(["the workload has no command"]);
  if (a.requiresNetworkAtFirstStart) warnings.push("The first start downloads files (Mojang jar / libraries); the container needs outbound HTTPS.");

  // --- files -------------------------------------------------------------------------------
  const files: MinecraftProvisioning["files"] = [];
  const deferredFiles: MinecraftProvisioning["deferredFiles"] = [];
  let gamerules: string[] = [];
  if (isProxy) {
    const current = input.currentFiles?.["velocity.toml"] ?? null;
    const bind = `0.0.0.0:${input.primary.port}`;
    if (current === null) {
      deferredFiles.push({
        path: "velocity.toml",
        reason: `Velocity writes its version-specific default velocity.toml on first start (binding 0.0.0.0:25565, which is not published). Start it once, stop it, then provision again to set bind = "${bind}".`,
      });
    } else {
      const r = setVelocityBind(current, bind);
      if (r.changed) files.push({ path: "velocity.toml", content: r.content });
    }
  } else {
    const gp = gameplayToProperties(input.gameplay ?? {}, a.version);
    warnings.push(...gp.warnings);
    gamerules = gp.gameRules.map((g) => g.command);
    const platform = platformProperties({ containerPort: input.primary.port, query: { enabled: false, port: input.primary.port }, minecraftVersion: a.version });
    platform["enable-rcon"] = "false";
    const current = input.currentFiles?.["server.properties"] ?? null;
    // Gameplay first, then platform keys, which always win (the platform owns ports/RCON).
    const content = updatePropertiesText(current ?? "", { ...gp.properties, ...platform });
    if (content !== current) files.push({ path: "server.properties", content });
    if (current === null) warnings.push("server.properties is created with only the managed keys; the server adds its remaining defaults on first start.");
    files.push({ path: "eula.txt", content: generateEula(input.acceptedAt ?? new Date(), input.acceptedBy === undefined ? {} : { acceptedBy: input.acceptedBy }) });
  }

  return { downloads, install, workload, files, deferredFiles, gamerules, warnings };
}
