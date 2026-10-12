import { z } from "zod";
import { Bytes, DisplayName, EpochMs, Id, Port, Slug } from "../common.js";
import { WorkloadMetricSample } from "../agent/metrics.js";
import { RestartPolicy } from "../agent/workload.js";
import { DesiredState, ServerOperation, ServerState } from "../lifecycle.js";

export const ServerSoftware = z.enum([
  "vanilla",
  "paper",
  "purpur",
  "folia",
  "spigot",
  "fabric",
  "forge",
  "neoforge",
  "velocity",
]);
export type ServerSoftware = z.infer<typeof ServerSoftware>;

export const ServerKind = z.enum(["game", "proxy"]);
export type ServerKind = z.infer<typeof ServerKind>;

export const Server = z.object({
  id: Id,
  name: z.string(),
  slug: z.string(),
  kind: ServerKind,
  nodeId: Id,
  nodeName: z.string(),
  networkId: Id.nullable(),
  software: ServerSoftware,
  minecraftVersion: z.string(),
  build: z.string().nullable(),
  javaMajor: z.number().int().nullable(),
  state: ServerState,
  desiredState: DesiredState,
  activeOperation: ServerOperation.nullable(),
  activeJobId: Id.nullable(),
  memoryLimitBytes: Bytes,
  heapMaxBytes: Bytes,
  cpuLimitMillicores: z.number().int().nullable(),
  storageQuotaBytes: Bytes.nullable(),
  port: Port,
  hostIp: z.string(),
  address: z.string().nullable(),
  startup: z.enum(["manual", "auto"]),
  restartPolicy: RestartPolicy,
  timezone: z.string(),
  location: z.string().nullable(),
  lastStartedAt: EpochMs.nullable(),
  lastCrashAt: EpochMs.nullable(),
  lastExitCode: z.number().int().nullable(),
  createdAt: EpochMs,
  latest: WorkloadMetricSample.nullable(),
});
export type Server = z.infer<typeof Server>;

export const ServerListQuery = z.object({
  limit: z.coerce.number().int().min(1).max(200).default(100),
  cursor: z.string().optional(),
  nodeId: Id.optional(),
  networkId: Id.optional(),
  state: ServerState.optional(),
  q: z.string().max(80).optional(),
});

/** Gameplay settings exposed by the wizard; anything else goes through the raw editor. */
export const GameplaySettings = z
  .object({
    motd: z.string().max(256),
    maxPlayers: z.number().int().min(1).max(10_000),
    difficulty: z.enum(["peaceful", "easy", "normal", "hard"]),
    gamemode: z.enum(["survival", "creative", "adventure", "spectator"]),
    onlineMode: z.boolean(),
    whitelist: z.boolean(),
    spawnProtection: z.number().int().min(0).max(1000),
    viewDistance: z.number().int().min(2).max(32),
    simulationDistance: z.number().int().min(2).max(32),
    pvp: z.boolean(),
    enableCommandBlock: z.boolean(),
    allowNether: z.boolean(),
    hardcore: z.boolean(),
    levelSeed: z.string().max(64),
    levelType: z.string().max(64),
    generateStructures: z.boolean(),
    resourcePack: z.string().max(1024),
    resourcePackSha1: z.string().max(40),
    requireResourcePack: z.boolean(),
  })
  .partial();
export type GameplaySettings = z.infer<typeof GameplaySettings>;

export const PROXY_SOFTWARE: readonly ServerSoftware[] = ["velocity"];
export const softwareKind = (software: ServerSoftware): ServerKind =>
  PROXY_SOFTWARE.includes(software) ? "proxy" : "game";

/** Unrefined shape (use for `.partial()`/`.pick()`); validate requests with `CreateServerRequest`. */
export const CreateServerBase = z.object({
  name: DisplayName,
  slug: Slug,
  kind: ServerKind.default("game"),
  placement: z.discriminatedUnion("mode", [
    z.object({ mode: z.literal("node"), nodeId: Id }),
    z.object({ mode: z.literal("auto"), preferTags: z.array(z.string()).default([]), location: z.string().optional() }),
  ]),
  /** Admin override of capacity policy (requires nodes.manage on the target node; audited). */
  overrideCapacity: z.boolean().default(false),
  networkId: Id.nullable().default(null),
  software: ServerSoftware,
  minecraftVersion: z.string().min(1).max(32),
  /** Build identifier from the catalogue; null = latest stable. */
  build: z.string().max(64).nullable().default(null),
  memoryLimitBytes: Bytes.min(512 * 1024 * 1024),
  /** Heap max; defaults to ~80% of the container limit. */
  heapMaxBytes: Bytes.optional(),
  cpuLimitMillicores: z.number().int().min(250).nullable().default(null),
  storageQuotaBytes: Bytes.nullable().default(null),
  port: Port.nullable().default(null),
  hostIp: z.string().default("0.0.0.0"),
  javaMajor: z.number().int().min(8).max(40).nullable().default(null),
  jvmArgs: z.array(z.string().max(512).regex(/^-[^\0\r\n]*$/)).max(64).default([]),
  jvmPreset: z.enum(["default", "aikar", "none"]).default("default"),
  startup: z.enum(["manual", "auto"]).default("auto"),
  restartPolicy: RestartPolicy.default({ mode: "on-failure", maxRetries: 3, backoffMs: 10_000 }),
  timezone: z.string().max(64).default("UTC"),
  location: z.string().max(80).nullable().default(null),
  acceptEula: z.literal(true),
  gameplay: GameplaySettings.default({}),
  world: z
    .discriminatedUnion("mode", [
      z.object({ mode: z.literal("generate") }),
      z.object({ mode: z.literal("upload"), transferId: Id }),
    ])
    .default({ mode: "generate" }),
});
export const CreateServerRequest = CreateServerBase.superRefine((req, ctx) => {
  if (softwareKind(req.software) !== req.kind) {
    ctx.addIssue({ code: "custom", path: ["kind"], message: `${req.software} requires kind "${softwareKind(req.software)}"` });
  }
  if (req.heapMaxBytes !== undefined && req.heapMaxBytes >= req.memoryLimitBytes) {
    ctx.addIssue({ code: "custom", path: ["heapMaxBytes"], message: "heap must be smaller than the memory limit" });
  }
});
export type CreateServerRequest = z.infer<typeof CreateServerRequest>;

export const ServerActionRequest = z.object({
  action: z.enum(["start", "stop", "restart", "kill"]),
  /** Graceful stop timeout before escalation. */
  timeoutMs: z.number().int().min(5000).max(600_000).optional(),
});

export const ConsoleCommandRequest = z.object({
  command: z.string().trim().min(1).max(1024).regex(/^[^\0\r\n]*$/),
});

/** Catalogue (wizard step 2). */
export const SoftwareInfo = z.object({
  software: ServerSoftware,
  displayName: z.string(),
  kind: ServerKind,
  description: z.string(),
  supportsPlugins: z.boolean(),
  supportsMods: z.boolean(),
  restrictions: z.array(z.string()),
  source: z.string(),
});
export const SoftwareVersion = z.object({
  minecraftVersion: z.string(),
  channel: z.enum(["release", "snapshot", "beta", "alpha", "experimental"]),
  javaMajor: z.number().int().nullable(),
  releasedAt: EpochMs.nullable(),
});
export const SoftwareBuild = z.object({
  build: z.string(),
  channel: z.enum(["stable", "beta", "alpha", "experimental"]),
  downloadUrl: z.string(),
  checksum: z.object({ algorithm: z.enum(["sha1", "sha256", "sha512"]), value: z.string() }).nullable(),
  releasedAt: EpochMs.nullable(),
  provenance: z.string(),
  notes: z.array(z.string()).default([]),
});
export type SoftwareInfo = z.infer<typeof SoftwareInfo>;
export type SoftwareVersion = z.infer<typeof SoftwareVersion>;
export type SoftwareBuild = z.infer<typeof SoftwareBuild>;
