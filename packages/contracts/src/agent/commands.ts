import { z } from "zod";
import { Bytes, Port } from "../common.js";
import { NodeFacts } from "./facts.js";
import { SlpStatus } from "./metrics.js";
import { FileEntry, LogLine, WorkloadSpec, WorkloadStatus } from "./workload.js";

/**
 * Path relative to a workload's data root. This is a first line of defence only — the agent
 * re-validates and resolves symlinks before touching the filesystem.
 */
export const RelativePath = z
  .string()
  .max(1024)
  .refine((p) => !p.includes("\0"), "NUL byte")
  .refine((p) => !/^([/\\]|[a-zA-Z]:)/.test(p), "must be relative")
  .refine((p) => !p.split(/[/\\]/).includes(".."), "must not contain '..'");

const isRootPath = (p: string) => p.split(/[/\\]/).every((seg) => seg === "" || seg === ".");
/** A relative path that must not resolve to the data root itself ("", ".", "./", …). Used by every mutation. */
export const MutableRelativePath = RelativePath.refine((p) => !isRootPath(p), "must not target the data root");

const WorkloadRef = z.object({ workloadId: z.uuid() });
/**
 * Optional template `fileDenylist` (semantics: `../denylist.ts`). When present the agent refuses
 * (`PATH_FORBIDDEN`, details `{reason: "denylist"}`) if the requested path OR its symlink-resolved
 * location inside the sandbox — or, for directories, any entry it would read/copy/archive — is denied.
 * The control plane sends it for every request made on behalf of non-administrators.
 */
const Denylist = z.array(z.string().max(512)).max(256).optional();
const DenyRef = WorkloadRef.extend({ denylist: Denylist });
const Empty = z.object({});

export const Checksum = z.object({
  algorithm: z.enum(["sha1", "sha256", "sha512"]),
  value: z.string().regex(/^[a-f0-9]{40,128}$/),
});
export type Checksum = z.infer<typeof Checksum>;

/** The complete command catalogue: payload and result schema per command type. */
export const AGENT_COMMANDS = {
  "node.facts": { payload: Empty, result: NodeFacts },
  /** Ports currently listening on the host (best effort; used to warn about allocation conflicts). */
  "node.ports": {
    payload: Empty,
    result: z.object({ tcp: z.array(Port), udp: z.array(Port) }),
  },
  "node.probe": {
    payload: z.object({
      host: z.string().min(1).max(253),
      port: Port,
      kind: z.enum(["tcp", "minecraft"]),
      timeoutMs: z.number().int().min(100).max(30_000).default(3000),
    }),
    result: z.object({
      reachable: z.boolean(),
      latencyMs: z.number().min(0).optional(),
      error: z.string().optional(),
      minecraft: SlpStatus.optional(),
    }),
  },
  "workload.ensure": {
    payload: WorkloadSpec,
    result: z.object({ created: z.boolean(), changed: z.boolean(), status: WorkloadStatus }),
  },
  /**
   * One-shot install container (egg install scripts). Runs `<entrypoint> /mnt/install/install.sh` with the
   * workload data dir at `/mnt/server`, as root with a minimal capability set (CHOWN, DAC_OVERRIDE, FOWNER,
   * SETUID, SETGID), no-new-privileges, resource limits and outbound network. Afterwards the agent chowns
   * `/mnt/server` to the workload UID/GID. Output streams as `logs` frames with `source: "install"`.
   * Only one install or workload container per workload at a time (`BUSY`).
   */
  "workload.install": {
    payload: WorkloadRef.extend({
      image: z.string().min(1).max(255),
      entrypoint: z.enum(["bash", "ash", "sh"]),
      script: z.string().max(64 * 1024),
      env: z.record(z.string().regex(/^[A-Za-z_][A-Za-z0-9_]{0,127}$/), z.string().max(16 * 1024)).default({}),
      memoryLimitBytes: Bytes.min(128 * 1024 * 1024),
      cpuLimitMillicores: z.number().int().min(100).nullable(),
      timeoutMs: z.number().int().min(60_000).max(3 * 3600_000).default(30 * 60_000),
    }),
    result: z.object({
      exitCode: z.number().int(),
      durationMs: z.number().int().nonnegative(),
      timedOut: z.boolean(),
      /** Last ≤ 200 output lines (untrusted). */
      logTail: z.array(z.string()),
    }),
  },
  "workload.start": { payload: WorkloadRef, result: WorkloadStatus },
  "workload.stop": {
    payload: WorkloadRef.extend({ timeoutMs: z.number().int().min(1000).max(600_000).default(60_000) }),
    result: WorkloadStatus,
  },
  "workload.kill": { payload: WorkloadRef, result: WorkloadStatus },
  "workload.remove": { payload: WorkloadRef.extend({ deleteData: z.boolean() }), result: Empty },
  "workload.status": {
    payload: z.object({ workloadId: z.uuid().optional() }),
    result: z.object({ workloads: z.array(WorkloadStatus) }),
  },
  "workload.console": {
    payload: WorkloadRef.extend({
      line: z.string().min(1).max(1024).regex(/^[^\0\r\n]*$/, "single line only"),
    }),
    result: Empty,
  },
  "workload.logs.tail": {
    payload: WorkloadRef.extend({
      lines: z.number().int().min(1).max(5000).default(500),
      sinceTs: z.number().int().nonnegative().optional(),
    }),
    result: z.object({ lines: z.array(LogLine) }),
  },
  "fs.list": {
    payload: WorkloadRef.extend({ path: RelativePath }),
    /** The agent caps listings (50 000 entries); `truncated` tells the UI to suggest search instead. */
    result: z.object({ entries: z.array(FileEntry), truncated: z.boolean().default(false) }),
  },
  "fs.stat": { payload: WorkloadRef.extend({ path: RelativePath }), result: FileEntry },
  "fs.read": {
    payload: DenyRef.extend({ path: RelativePath, maxBytes: z.number().int().min(1).max(5 * 1024 * 1024) }),
    result: z.object({
      content: z.string(),
      encoding: z.enum(["utf8", "base64"]),
      sha256: z.string(),
      size: Bytes,
      truncated: z.boolean(),
    }),
  },
  "fs.write": {
    payload: DenyRef.extend({
      path: MutableRelativePath,
      content: z.string().max(7 * 1024 * 1024),
      encoding: z.enum(["utf8", "base64"]),
      /** sha256 the current file must have; null = file must not exist; omitted = unconditional. */
      ifMatchSha256: z.string().nullable().optional(),
      createParents: z.boolean().default(false),
    }),
    result: z.object({ sha256: z.string(), size: Bytes }),
  },
  "fs.mkdir": { payload: DenyRef.extend({ path: MutableRelativePath }), result: Empty },
  "fs.rename": { payload: DenyRef.extend({ from: MutableRelativePath, to: MutableRelativePath }), result: Empty },
  "fs.delete": { payload: DenyRef.extend({ path: MutableRelativePath, recursive: z.boolean() }), result: Empty },
  /** Copies a file or directory next to itself ("name copy.ext", "name copy 2.ext", …). */
  "fs.copy": {
    payload: DenyRef.extend({ path: MutableRelativePath }),
    result: z.object({ path: z.string() }),
  },
  "fs.compress": {
    payload: DenyRef.extend({
      root: RelativePath,
      paths: z.array(MutableRelativePath).min(1).max(1000),
      format: z.enum(["tar.gz", "zip"]),
      /** Archive path; default = `<root>/archive-<UTC timestamp>.<ext>`. Must not exist. */
      destPath: MutableRelativePath.optional(),
      maxTotalBytes: Bytes.max(64 * 1024 ** 3),
    }),
    result: z.object({ path: z.string(), size: Bytes, entries: z.number().int() }),
  },
  /** Permission bits only (0–0777); setuid/setgid/sticky are never set. Symlinks are refused. */
  "fs.chmod": {
    payload: DenyRef.extend({ path: MutableRelativePath, mode: z.number().int().min(0).max(0o777) }),
    result: Empty,
  },
  /** Case-insensitive substring match on file/dir names below `path` (no regex), bounded walk. */
  "fs.find": {
    payload: WorkloadRef.extend({
      path: RelativePath,
      query: z.string().min(1).max(64),
      maxResults: z.number().int().min(1).max(500).default(100),
    }),
    result: z.object({ matches: z.array(FileEntry), truncated: z.boolean() }),
  },
  "fs.du": {
    payload: WorkloadRef.extend({
      path: RelativePath,
      depth: z.number().int().min(0).max(3).default(1),
      top: z.number().int().min(1).max(50).default(20),
    }),
    result: z.object({
      totalBytes: Bytes,
      children: z.array(z.object({ path: z.string(), bytes: Bytes })),
      largestFiles: z.array(z.object({ path: z.string(), bytes: Bytes })),
    }),
  },
  "fs.extract": {
    payload: DenyRef.extend({
      archivePath: MutableRelativePath,
      destPath: RelativePath,
      maxTotalBytes: Bytes.max(64 * 1024 ** 3),
      maxEntries: z.number().int().min(1).max(1_000_000),
    }),
    result: z.object({ entries: z.number().int(), bytes: Bytes }),
  },
  "fs.transfer.push": {
    payload: DenyRef.extend({ path: MutableRelativePath, transferId: z.uuid() }),
    result: z.object({ bytes: Bytes, sha256: z.string() }),
  },
  "fs.transfer.pull": {
    payload: DenyRef.extend({ path: MutableRelativePath, transferId: z.uuid(), maxBytes: Bytes }),
    result: z.object({ bytes: Bytes, sha256: z.string() }),
  },
  "artifact.fetch": {
    payload: WorkloadRef.extend({
      url: z.url({ protocol: /^https$/ }),
      destPath: MutableRelativePath,
      checksum: Checksum.nullable(),
      maxBytes: Bytes.max(2 * 1024 ** 3),
      /**
       * Use/populate the node's content-addressed artifact cache (`<dataRoot>/cache/artifacts`). Only
       * applies when `checksum` is set; the file is hard-linked (or copied) into the sandbox.
       */
      cache: z.boolean().default(true),
    }),
    result: z.object({ bytes: Bytes, sha256: z.string(), cached: z.boolean().default(false) }),
  },
  /**
   * Staged rotation: the agent keeps its current key, generates a next key, and proves possession by
   * signing `ROTATION_PROOF_PREFIX + nodeId + ":" + commandId` with it. See agent-protocol.md §3.1.
   */
  "credentials.rotate": {
    payload: Empty,
    result: z.object({
      publicKey: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
      proof: z.string().regex(/^[A-Za-z0-9_-]{86}$/),
    }),
  },
} as const;

export type AgentCommandType = keyof typeof AGENT_COMMANDS;
export const AGENT_COMMAND_TYPES = Object.keys(AGENT_COMMANDS) as AgentCommandType[];
export type CommandPayload<T extends AgentCommandType> = z.input<(typeof AGENT_COMMANDS)[T]["payload"]>;
export type CommandResult<T extends AgentCommandType> = z.infer<(typeof AGENT_COMMANDS)[T]["result"]>;

export const ROTATION_PROOF_PREFIX = "blockforge-rotate:";

/**
 * Payload fields that may carry secrets. They are redacted (field level) before a payload is persisted
 * in `agent_commands`, job input, audit details or logs. URLs keep scheme/host/path but lose query + fragment.
 */
export const COMMAND_REDACTIONS: Partial<Record<AgentCommandType, readonly string[]>> = {
  "fs.write": ["content"],
  "workload.ensure": ["env", "command"],
  "workload.install": ["env", "script"],
  "artifact.fetch": ["url"],
};
export const SENSITIVE_COMMANDS = Object.keys(COMMAND_REDACTIONS) as AgentCommandType[];
export const REDACTED = "[REDACTED]";

export function redactCommandPayload(type: AgentCommandType, payload: unknown): unknown {
  const fields = COMMAND_REDACTIONS[type];
  if (!fields || typeof payload !== "object" || payload === null) return payload;
  const copy: Record<string, unknown> = { ...(payload as Record<string, unknown>) };
  for (const field of fields) {
    if (!(field in copy)) continue;
    const value = copy[field];
    if (field === "url" && typeof value === "string") {
      try {
        const u = new URL(value);
        copy[field] = `${u.protocol}//${u.host}${u.pathname}${u.search || u.hash ? "?" + REDACTED : ""}`;
      } catch {
        copy[field] = REDACTED;
      }
    } else if (field === "env" && value !== null && typeof value === "object") {
      copy[field] = Object.fromEntries(Object.keys(value).map((k) => [k, REDACTED]));
    } else if (field === "command" && Array.isArray(value)) {
      // JVM system properties may carry secrets (`-Dapi.token=…`): keep the key, mask the value.
      copy[field] = value.map((arg) =>
        typeof arg === "string" && /^-D[^=]+=/.test(arg) ? `${arg.slice(0, arg.indexOf("=") + 1)}${REDACTED}` : arg,
      );
    } else {
      copy[field] = REDACTED;
    }
  }
  return copy;
}
