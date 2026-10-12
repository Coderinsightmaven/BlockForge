import { z } from "zod";
import { Bytes, DisplayName, EpochMs, Id, Port, Slug } from "../common.js";
import { WorkloadMetricSample } from "../agent/metrics.js";
import { RestartPolicy } from "../agent/workload.js";
import { DesiredState, ServerOperation, ServerState } from "../lifecycle.js";
import { PermissionSchema } from "../permissions.js";
import { EnvVarName, TemplateGame, TemplateKind } from "./templates.js";

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

export const ServerAllocationRef = z.object({
  id: Id,
  ip: z.string(),
  port: Port,
  alias: z.string().nullable(),
  primary: z.boolean(),
});

export const Server = z.object({
  id: Id,
  /** First 8 hex chars of `id`; used in SFTP usernames (`<username>.<shortId>`). */
  shortId: z.string().regex(/^[0-9a-f]{8}$/),
  name: z.string(),
  slug: z.string(),
  description: z.string(),
  kind: ServerKind,
  ownerId: Id,
  ownerName: z.string(),
  templateId: Id,
  templateName: z.string(),
  templateKind: TemplateKind,
  game: TemplateGame,
  nodeId: Id,
  nodeName: z.string(),
  networkId: Id.nullable(),
  /** Minecraft fields: null for egg-based servers. */
  software: ServerSoftware.nullable(),
  minecraftVersion: z.string().nullable(),
  build: z.string().nullable(),
  javaMajor: z.number().int().nullable(),
  heapMaxBytes: Bytes.nullable(),
  dockerImage: z.string(),
  state: ServerState,
  desiredState: DesiredState,
  activeOperation: ServerOperation.nullable(),
  activeJobId: Id.nullable(),
  /** Suspended servers cannot be started or accessed by non-administrators. */
  suspended: z.boolean(),
  memoryLimitBytes: Bytes,
  cpuLimitMillicores: z.number().int().nullable(),
  storageQuotaBytes: Bytes.nullable(),
  /** Max additional allocations (besides the primary) the server's users may assign. */
  allocationLimit: z.number().int().nonnegative(),
  backupLimit: z.number().int().nonnegative(),
  allocations: z.array(ServerAllocationRef),
  /** Connection address for players: primary allocation alias (or node public address, or ip) + port. */
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
  /** The requesting user's effective permissions on this server (UI gating; the API enforces anyway). */
  myPermissions: z.array(PermissionSchema),
  /** Present when the requesting user holds `servers.files.sftp` and the node runs the SFTP service. */
  sftp: z
    .object({
      host: z.string(),
      port: Port,
      username: z.string(),
      /** OpenSSH-style `SHA256:…` fingerprint of the node's SFTP host key. */
      hostKeyFingerprint: z.string(),
    })
    .nullable(),
});
export type Server = z.infer<typeof Server>;

export const ServerListQuery = z.object({
  limit: z.coerce.number().int().min(1).max(200).default(100),
  cursor: z.string().optional(),
  nodeId: Id.optional(),
  networkId: Id.optional(),
  state: ServerState.optional(),
  ownerId: Id.optional(),
  templateId: Id.optional(),
  /** `mine` = servers the user owns or is a subuser of (the client dashboard). */
  filter: z.enum(["all", "mine"]).default("all"),
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

/** Options for built-in `minecraft` / `velocity` templates. */
export const MinecraftOptions = z.object({
  software: ServerSoftware,
  /** Minecraft version (Velocity: the proxy version). */
  version: z.string().min(1).max(32),
  /** Build identifier from the catalogue; null = latest stable. */
  build: z.string().max(64).nullable().default(null),
  javaMajor: z.number().int().min(8).max(40).nullable().default(null),
  /** Heap max; defaults to ~80% of the container limit. */
  heapMaxBytes: Bytes.optional(),
  jvmArgs: z.array(z.string().max(512).regex(/^-[^\0\r\n]*$/)).max(64).default([]),
  jvmPreset: z.enum(["default", "aikar", "none"]).default("default"),
  /** Required for game servers (Mojang EULA); ignored for Velocity. */
  acceptEula: z.boolean().default(false),
  gameplay: GameplaySettings.default({}),
  world: z
    .discriminatedUnion("mode", [
      z.object({ mode: z.literal("generate") }),
      z.object({ mode: z.literal("upload"), transferId: Id }),
    ])
    .default({ mode: "generate" }),
});
export type MinecraftOptions = z.infer<typeof MinecraftOptions>;

/** Options for `egg` templates. */
export const EggOptions = z.object({
  /** One of the template's images; default = the template's first image. */
  dockerImage: z.string().max(255).optional(),
  /** envName → value; omitted variables use the template default. Validated with the variable's rules. */
  variables: z.record(EnvVarName, z.string().max(8192)).default({}),
});
export type EggOptions = z.infer<typeof EggOptions>;

/** Unrefined shape (use for `.partial()`/`.pick()`); validate requests with `CreateServerRequest`. */
export const CreateServerBase = z.object({
  name: DisplayName,
  slug: Slug,
  description: z.string().max(1024).default(""),
  /** Defaults to the requester. Creating a server for someone else requires `servers.admin`. */
  ownerId: Id.optional(),
  templateId: Id,
  placement: z.discriminatedUnion("mode", [
    z.object({ mode: z.literal("node"), nodeId: Id }),
    z.object({ mode: z.literal("auto"), preferTags: z.array(z.string()).default([]), location: z.string().optional() }),
  ]),
  /** Admin override of capacity policy (requires nodes.manage on the target node; audited). */
  overrideCapacity: z.boolean().default(false),
  networkId: Id.nullable().default(null),
  /** Primary allocation: a specific free allocation on the target node, or the first free one. */
  allocation: z
    .discriminatedUnion("mode", [z.object({ mode: z.literal("auto") }), z.object({ mode: z.literal("specific"), allocationId: Id })])
    .default({ mode: "auto" }),
  memoryLimitBytes: Bytes.min(256 * 1024 * 1024),
  cpuLimitMillicores: z.number().int().min(250).nullable().default(null),
  storageQuotaBytes: Bytes.nullable().default(null),
  allocationLimit: z.number().int().min(0).max(50).default(0),
  backupLimit: z.number().int().min(0).max(100).default(3),
  startup: z.enum(["manual", "auto"]).default("auto"),
  restartPolicy: RestartPolicy.default({ mode: "on-failure", maxRetries: 3, backoffMs: 10_000 }),
  timezone: z.string().max(64).default("UTC"),
  location: z.string().max(80).nullable().default(null),
  /** Exactly one of `minecraft` (built-in templates) or `egg` (imported templates) must be set. */
  minecraft: MinecraftOptions.optional(),
  egg: EggOptions.optional(),
});
export const CreateServerRequest = CreateServerBase.superRefine((req, ctx) => {
  if ((req.minecraft === undefined) === (req.egg === undefined)) {
    ctx.addIssue({ code: "custom", path: ["minecraft"], message: "set exactly one of `minecraft` or `egg`" });
  }
  const mc = req.minecraft;
  if (mc?.heapMaxBytes !== undefined && mc.heapMaxBytes >= req.memoryLimitBytes) {
    ctx.addIssue({ code: "custom", path: ["minecraft", "heapMaxBytes"], message: "heap must be smaller than the memory limit" });
  }
  if (mc && softwareKind(mc.software) === "game" && !mc.acceptEula) {
    ctx.addIssue({ code: "custom", path: ["minecraft", "acceptEula"], message: "the Minecraft EULA must be accepted" });
  }
});
export type CreateServerRequest = z.infer<typeof CreateServerRequest>;

// ---------------------------------------------------------------------------
// Subusers, startup, settings

export const ServerSubuser = z.object({
  id: Id,
  serverId: Id,
  userId: Id,
  username: z.string(),
  email: z.string(),
  permissions: z.array(PermissionSchema),
  createdAt: EpochMs,
});
export type ServerSubuser = z.infer<typeof ServerSubuser>;
export const AddSubuserRequest = z.object({
  /** Email or username of an existing account. */
  user: z.string().min(1).max(254),
  permissions: z.array(PermissionSchema).min(1),
});
export const UpdateSubuserRequest = z.object({ permissions: z.array(PermissionSchema).min(1) });

export const ServerStartup = z.object({
  templateKind: TemplateKind,
  dockerImages: z.array(z.object({ label: z.string(), image: z.string() })),
  dockerImage: z.string(),
  /** Template startup string with `{{VAR}}` placeholders (egg templates); null for built-ins. */
  startupCommand: z.string().nullable(),
  /** Startup with values substituted; non-viewable variable values are replaced by `••••`. */
  resolvedStartup: z.string().nullable(),
  variables: z.array(
    z.object({
      envName: EnvVarName,
      name: z.string(),
      description: z.string(),
      /** null when the variable is not user-viewable and the requester is not an administrator. */
      value: z.string().nullable(),
      defaultValue: z.string(),
      editable: z.boolean(),
      rules: z.string(),
    }),
  ),
  minecraft: MinecraftOptions.pick({ software: true, version: true, build: true, javaMajor: true, jvmArgs: true, jvmPreset: true })
    .extend({ heapMaxBytes: Bytes })
    .nullable(),
});
export type ServerStartup = z.infer<typeof ServerStartup>;
export const UpdateStartupVariableRequest = z.object({ envName: EnvVarName, value: z.string().max(8192) });
export const UpdateDockerImageRequest = z.object({ image: z.string().min(1).max(255) });

/** `PATCH /servers/:id` (servers.settings.edit). */
export const UpdateServerSettingsRequest = z.object({
  name: DisplayName.optional(),
  description: z.string().max(1024).optional(),
});
/** `PATCH /servers/:id/build` (servers.admin). Memory/CPU changes apply on next restart. */
export const UpdateServerBuildRequest = z.object({
  memoryLimitBytes: Bytes.min(256 * 1024 * 1024).optional(),
  cpuLimitMillicores: z.number().int().min(250).nullable().optional(),
  storageQuotaBytes: Bytes.nullable().optional(),
  allocationLimit: z.number().int().min(0).max(50).optional(),
  backupLimit: z.number().int().min(0).max(100).optional(),
  ownerId: Id.optional(),
  restartPolicy: RestartPolicy.optional(),
  startup: z.enum(["manual", "auto"]).optional(),
});

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
export const JavaSource = z.enum(["upstream", "mojang", "table"]);
export const SoftwareVersion = z.object({
  /** Minecraft version for game servers; for proxies (Velocity) the proxy's own version. */
  minecraftVersion: z.string(),
  channel: z.enum(["release", "snapshot", "beta", "alpha", "experimental"]),
  javaMajor: z.number().int().nullable(),
  releasedAt: EpochMs.nullable(),
  /** Where `javaMajor` came from: upstream build metadata, Mojang's per-version JSON, or BlockForge's table. */
  javaSource: JavaSource.nullable().default(null),
  support: z.enum(["supported", "deprecated", "unsupported"]).nullable().default(null),
  notes: z.array(z.string()).default([]),
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

/**
 * Resolved provisioning plan for one build (wizard review step: `GET /catalog/software/:software/
 * versions/:version/builds/:build/plan`; `build = "latest"` resolves the newest stable build).
 * Structurally identical to `ResolvedArtifact` in `@blockforge/minecraft`.
 *
 * Checksums: `checksum` is the strongest value the upstream publishes (may be MD5, shown to users as
 * weak); `agentChecksum` is what the agent enforces (sha1/sha256/sha512 only) — `null` means the file
 * is protected by TLS only, and the UI must say so. MD5 is intentionally not an agent algorithm: it
 * comes from the same origin as the file, so it adds no protection beyond TLS.
 */
export const ArtifactPlan = z.object({
  software: ServerSoftware,
  version: z.string(),
  build: z.string(),
  channel: z.enum(["stable", "beta", "alpha", "experimental"]),
  releasedAt: EpochMs.nullable(),
  downloads: z.array(
    z.object({
      role: z.enum(["server", "installer", "launcher", "vanilla-server"]),
      url: z.string(),
      destPath: z.string(),
      checksum: z.object({ algorithm: z.enum(["md5", "sha1", "sha256", "sha512"]), value: z.string() }).nullable(),
      agentChecksum: z.object({ algorithm: z.enum(["sha1", "sha256", "sha512"]), value: z.string() }).nullable(),
      sizeBytes: z.number().int().nullable(),
      provenance: z.string(),
    }),
  ),
  java: z.object({ major: z.number().int(), source: JavaSource, notes: z.array(z.string()) }),
  install: z.discriminatedUnion("kind", [
    z.object({ kind: z.literal("none") }),
    z.object({
      kind: z.literal("installer"),
      javaArgs: z.array(z.string()),
      expects: z.array(z.string()),
      cleanup: z.array(z.string()),
      requiresNetwork: z.boolean(),
      notes: z.array(z.string()),
    }),
  ]),
  launch: z.discriminatedUnion("kind", [
    z.object({ kind: z.literal("jar"), jar: z.string(), programArgs: z.array(z.string()) }),
    z.object({ kind: z.literal("argfile"), argFile: z.string(), programArgs: z.array(z.string()) }),
    z.object({ kind: z.literal("jar-candidates"), candidates: z.array(z.string()), programArgs: z.array(z.string()) }),
  ]),
  requiresNetworkAtFirstStart: z.boolean(),
  recommendedJvmFlags: z.array(z.string()).nullable(),
  provenance: z.string(),
  notes: z.array(z.string()),
});
export type ArtifactPlan = z.infer<typeof ArtifactPlan>;
