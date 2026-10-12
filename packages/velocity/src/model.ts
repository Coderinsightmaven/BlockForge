import { z } from "zod";
import { ServerSoftware } from "@blockforge/contracts";

/**
 * Typed network model used to render Velocity and backend configuration. It never contains the
 * forwarding secret: the secret is passed separately to the functions that write the secret file
 * and backend configs, and only a `SecretAssessment` reaches the validator.
 */

/** Velocity `player-info-forwarding-mode` values (default-velocity.toml, 4.2.0). */
export const ForwardingMode = z.enum(["none", "legacy", "bungeeguard", "modern"]);
export type ForwardingMode = z.infer<typeof ForwardingMode>;

/**
 * Backend (Velocity `[servers]` key) names: lowercase, digits, `_`/`-`, ≤ 32 chars. `try` is
 * reserved by Velocity (VelocityConfiguration.Servers treats it as the connection order).
 */
export const BackendName = z
  .string()
  .regex(/^[a-z0-9][a-z0-9_-]{0,31}$/, "Use 1–32 lowercase letters, digits, '-' or '_'")
  .refine((n) => n !== "try", "'try' is reserved by Velocity");
export type BackendName = z.infer<typeof BackendName>;

const Port = z.number().int().min(1).max(65535);

/** Host-side port publishing of a container (Docker `-p hostIp:hostPort:containerPort`). */
export const PublishedPort = z.object({
  nodeId: z.string().nullable().default(null),
  hostIp: z.string().min(1).max(64),
  hostPort: Port,
});
export type PublishedPort = z.infer<typeof PublishedPort>;

export const PingPassthrough = z.object({
  version: z.boolean().default(false),
  players: z.boolean().default(false),
  description: z.boolean().default(false),
  favicon: z.boolean().default(false),
  modinfo: z.boolean().default(false),
});

export const ProxySettings = z.object({
  /** `host:port` inside the container, e.g. `0.0.0.0:25565`. */
  bind: z.string().min(3).max(128).default("0.0.0.0:25565"),
  motd: z.string().max(1024).default("<#09add3>A Velocity Server"),
  showMaxPlayers: z.number().int().min(0).max(1_000_000).default(500),
  onlineMode: z.boolean().default(true),
  forceKeyAuthentication: z.boolean().default(true),
  forwardingMode: ForwardingMode.default("modern"),
  forwardingSecretFile: z
    .string()
    .regex(/^[A-Za-z0-9._-]{1,64}$/, "single relative file name")
    .refine((s) => s !== "." && s !== "..")
    .default("forwarding.secret"),
  announceForge: z.boolean().default(false),
  kickExistingPlayers: z.boolean().default(false),
  pingPassthrough: PingPassthrough.default({ version: false, players: false, description: false, favicon: false, modinfo: false }),
  compressionThreshold: z.number().int().min(-1).max(2_097_152).default(256),
  compressionLevel: z.number().int().min(-1).max(9).default(-1),
  connectionTimeoutMs: z.number().int().min(1).max(600_000).default(5000),
  readTimeoutMs: z.number().int().min(1).max(600_000).default(30_000),
  query: z.object({ enabled: z.boolean().default(false), port: Port.default(25565) }).default({ enabled: false, port: 25565 }),
});
export type ProxySettings = z.infer<typeof ProxySettings>;

export const ServerRuntimeState = z.enum(["running", "starting", "stopped", "crashed", "provisioning", "unknown"]);

export const ProxyNode = z.object({
  name: z.string().min(1).max(80),
  serverId: z.string().nullable().default(null),
  nodeId: z.string().nullable().default(null),
  velocityVersion: z.string().nullable().default(null),
  published: PublishedPort.nullable().default(null),
  /** Public IP or DNS name players reach the proxy at (for DNS guidance). */
  publicAddress: z.string().max(253).nullable().default(null),
  settings: ProxySettings,
});
export type ProxyNode = z.infer<typeof ProxyNode>;

export const BackendServer = z.object({
  name: BackendName,
  serverId: z.string().nullable().default(null),
  nodeId: z.string().nullable().default(null),
  /** Address the proxy connects to (Docker network alias, private IP, …). */
  host: z.string().min(1).max(253),
  port: Port,
  software: ServerSoftware,
  minecraftVersion: z.string().min(1).max(32),
  published: PublishedPort.nullable().default(null),
  /** Current `online-mode` of the backend, when known. */
  onlineMode: z.boolean().nullable().default(null),
  state: ServerRuntimeState.default("unknown"),
  /** false = registered in velocity.toml but no longer a member of this network. */
  inNetwork: z.boolean().default(true),
});
export type BackendServer = z.infer<typeof BackendServer>;

export const ForcedHostMapping = z.object({
  hostname: z.string().min(1).max(300),
  targets: z.array(z.string().max(64)).max(32),
});
export type ForcedHostMapping = z.infer<typeof ForcedHostMapping>;

export const NetworkModel = z.object({
  proxy: ProxyNode.nullable(),
  backends: z.array(BackendServer).max(256).default([]),
  /** Velocity `try` order (default/fallback servers). */
  try: z.array(z.string().max(64)).max(64).default([]),
  forcedHosts: z.array(ForcedHostMapping).max(512).default([]),
});
export type NetworkModel = z.infer<typeof NetworkModel>;
export type NetworkModelInput = z.input<typeof NetworkModel>;

export type IssueSeverity = "error" | "warning" | "info";

export interface NetworkIssue {
  severity: IssueSeverity;
  code: string;
  message: string;
  /** What the issue is about: "proxy", "network", a backend name or a hostname. */
  subject: string;
}
