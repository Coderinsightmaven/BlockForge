import { z } from "zod";
import { Bytes, EpochMs, Port } from "../common.js";

/** Environment variable name (eggs may use lowercase). */
export const EnvKey = z.string().regex(/^[A-Za-z_][A-Za-z0-9_]{0,127}$/);
/** argv element: printable, no NUL/newlines. No shell is ever involved. */
const Arg = z.string().min(1).max(4096).regex(/^[^\0\r\n]*$/);

export const RestartPolicy = z.object({
  mode: z.enum(["never", "on-failure", "always"]),
  maxRetries: z.number().int().min(0).max(100).default(3),
  backoffMs: z.number().int().min(1000).max(600_000).default(10_000),
});
export type RestartPolicy = z.infer<typeof RestartPolicy>;

export const PortBinding = z.object({
  containerPort: Port,
  hostPort: Port,
  /** Address on the node to bind to; "0.0.0.0" = all interfaces (public). */
  hostIp: z.union([z.ipv4(), z.ipv6()]).default("0.0.0.0"),
  protocol: z.enum(["tcp", "udp"]).default("tcp"),
});
export type PortBinding = z.infer<typeof PortBinding>;

export const WorkloadNetwork = z.object({
  /** Bridge network on the node; must start with "bf-". Created on demand by the agent. */
  name: z.string().regex(/^bf-[a-z0-9-]{1,60}$/),
  aliases: z.array(z.string().regex(/^[a-z0-9][a-z0-9-]{0,62}$/)).default([]),
});

export const WorkloadStop = z.discriminatedUnion("type", [
  /** Written to the console (stdin) followed by a newline. */
  z.object({ type: z.literal("command"), command: z.string().min(1).max(256).regex(/^[^\0\r\n]*$/) }),
  /** Sent to the container's main process. */
  z.object({ type: z.literal("signal"), signal: z.enum(["SIGINT", "SIGTERM", "SIGQUIT", "SIGKILL"]) }),
]);
export type WorkloadStop = z.infer<typeof WorkloadStop>;

export const WorkloadSpec = z.object({
  workloadId: z.uuid(),
  kind: z.enum(["minecraft", "velocity", "generic"]),
  /**
   * Image reference. The schema only checks shape; *authorisation* is the agent's own allowlist
   * (agent-protocol.md §6), never this schema.
   */
  image: z
    .string()
    .max(255)
    .regex(
      /^[a-z0-9]+(?:[._-][a-z0-9]+)*(?:\/[a-z0-9]+(?:[._-][a-z0-9]+)*)*(?::[A-Za-z0-9_][A-Za-z0-9._-]{0,127})?(?:@sha256:[a-f0-9]{64})?$/,
    ),
  /**
   * `argv` (default): `command` replaces the image entrypoint, no shell involved.
   * `image`: keep the image's own ENTRYPOINT/CMD and pass `command` (usually empty) as CMD. Used for
   * egg "yolk" images whose entrypoint evaluates `STARTUP` — a shell *inside* the container.
   */
  entrypoint: z.enum(["argv", "image"]).default("argv"),
  command: z.array(Arg).max(256),
  env: z.record(EnvKey, z.string().max(16 * 1024)).default({}),
  /** Where `<dataRoot>/servers/<id>/data` is mounted; also the working directory and `HOME`. */
  dataMountPath: z.enum(["/data", "/home/container"]).default("/data"),
  readOnlyRootfs: z.boolean().default(true),
  memoryLimitBytes: Bytes.min(128 * 1024 * 1024),
  cpuLimitMillicores: z.number().int().min(100).max(1_024_000).nullable(),
  pidsLimit: z.number().int().min(64).max(65536).default(4096),
  ports: z.array(PortBinding).max(16).default([]),
  networks: z.array(WorkloadNetwork).max(8).default([]),
  /** null = SIGTERM, then SIGKILL after 15 s. */
  stop: WorkloadStop.nullable(),
  stopTimeoutMs: z.number().int().min(1000).max(600_000).default(60_000),
  restartPolicy: RestartPolicy,
  jvmProbe: z.boolean().default(true),
  labels: z.record(z.string().regex(/^[a-z0-9.\-/]{1,128}$/), z.string().max(256)).default({}),
});
export type WorkloadSpec = z.infer<typeof WorkloadSpec>;
/** Refinement used by both sides: `argv` workloads need a command. */
export const isValidWorkloadSpec = (s: WorkloadSpec) => s.entrypoint === "image" || s.command.length > 0;

export const WorkloadRuntimeState = z.enum(["created", "running", "restarting", "exited", "dead", "missing"]);
export type WorkloadRuntimeState = z.infer<typeof WorkloadRuntimeState>;

export const WorkloadStatus = z.object({
  workloadId: z.uuid(),
  exists: z.boolean(),
  state: WorkloadRuntimeState,
  exitCode: z.number().int().optional(),
  oomKilled: z.boolean().optional(),
  startedAt: EpochMs.optional(),
  finishedAt: EpochMs.optional(),
  restartCount: z.number().int().nonnegative().default(0),
  image: z.string().optional(),
  containerId: z.string().optional(),
  /** Hash of the applied spec so the control plane can detect drift. */
  specHash: z.string().optional(),
});
export type WorkloadStatus = z.infer<typeof WorkloadStatus>;

export const LogLine = z.object({
  ts: EpochMs,
  stream: z.enum(["stdout", "stderr"]),
  /** Untrusted content; truncated to 8 KiB by the agent. */
  line: z.string(),
});
export type LogLine = z.infer<typeof LogLine>;

export const FileEntry = z.object({
  name: z.string(),
  path: z.string(),
  type: z.enum(["file", "dir", "symlink", "other"]),
  size: Bytes,
  modifiedAt: EpochMs,
  mode: z.string().optional(),
});
export type FileEntry = z.infer<typeof FileEntry>;
