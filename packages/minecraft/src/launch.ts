import type { ServerSoftware } from "@blockforge/contracts";
import type { LaunchTarget, ResolvedArtifact } from "./catalog/types.js";
import { javaImage, runtimeMajorFor } from "./java.js";

/**
 * Builds the container argv (no shell) for a server: `{image, command, stopCommand, env}` for
 * `WorkloadSpec`.
 *
 * Heap default: min(limit × 0.8, limit − 512 MiB), never below min(256 MiB, limit / 2), rounded
 * down to MiB — the rest is left for metaspace, threads, direct buffers and the JVM itself.
 *
 * Presets:
 *  - `default`: `-Xms<min(heap, 1 GiB)> -Xmx<heap> -XX:+UseG1GC` (G1 explicitly, because the JVM
 *    falls back to SerialGC in containers with < 2 CPUs or < 1792 MB).
 *  - `aikar`: Aikar's flags as documented by PaperMC (docs.papermc.io/paper/aikars-flags; the
 *    same list is served by the Fill API as `java.flags.recommended`, verified 2026-10-11) with
 *    `-Xms = -Xmx`. Only for Paper-family servers (paper, purpur, folia) with heap ≥ 4 GiB;
 *    PaperMC recommends 6–10 GB, below 6 GiB a warning is emitted. `AlwaysPreTouch` commits the
 *    whole heap at start.
 *  - `none`: only `-Xmx` (plus validated user flags).
 */

export type JvmPreset = "default" | "aikar" | "none";

const MiB = 1024 * 1024;
const GiB = 1024 * MiB;

export const AIKAR_FLAGS: readonly string[] = [
  "-XX:+UseG1GC",
  "-XX:+ParallelRefProcEnabled",
  "-XX:MaxGCPauseMillis=200",
  "-XX:+UnlockExperimentalVMOptions",
  "-XX:+DisableExplicitGC",
  "-XX:+AlwaysPreTouch",
  "-XX:G1NewSizePercent=30",
  "-XX:G1MaxNewSizePercent=40",
  "-XX:G1HeapRegionSize=8M",
  "-XX:G1ReservePercent=20",
  "-XX:G1HeapWastePercent=5",
  "-XX:G1MixedGCCountTarget=4",
  "-XX:InitiatingHeapOccupancyPercent=15",
  "-XX:G1MixedGCLiveThresholdPercent=90",
  "-XX:G1RSetUpdatingPauseTimePercent=5",
  "-XX:SurvivorRatio=32",
  "-XX:+PerfDisableSharedMem",
  "-XX:MaxTenuringThreshold=1",
  "-Dusing.aikars.flags=https://mcflags.emc.gs",
  "-Daikars.new.flags=true",
];

export const AIKAR_SOFTWARE: readonly ServerSoftware[] = ["paper", "purpur", "folia"];
export const AIKAR_MIN_HEAP_BYTES = 4 * GiB;

export interface LaunchIssue {
  code:
    | "FORBIDDEN_JVM_FLAG"
    | "HEAP_FLAG_CONFLICT"
    | "HEAP_ABOVE_LIMIT"
    | "HEAP_TOO_SMALL"
    | "LOW_HEADROOM"
    | "XMS_ABOVE_XMX"
    | "GC_CONFLICT"
    | "AIKAR_NOT_APPLICABLE"
    | "AIKAR_SMALL_HEAP"
    | "INVALID_JVM_ARG"
    | "LAUNCH_JAR_UNRESOLVED"
    | "INVALID_TIMEZONE";
  severity: "error" | "warning";
  message: string;
  arg?: string;
}

export class LaunchValidationError extends Error {
  readonly issues: LaunchIssue[];
  constructor(issues: LaunchIssue[]) {
    super(issues.filter((i) => i.severity === "error").map((i) => i.message).join("; "));
    this.name = "LaunchValidationError";
    this.issues = issues;
  }
}

/** Parses JVM memory sizes (`512M`, `4G`, `1048576`, `2048k`). */
export function parseJvmSize(s: string): number | null {
  const m = /^(\d{1,15})([kKmMgGtT]?)$/.exec(s);
  if (!m) return null;
  const n = Number(m[1]);
  const unit = (m[2] ?? "").toLowerCase();
  const mult = unit === "k" ? 1024 : unit === "m" ? MiB : unit === "g" ? GiB : unit === "t" ? 1024 * GiB : 1;
  return n * mult;
}

export function formatJvmSize(bytes: number): string {
  return `${Math.floor(bytes / MiB)}M`;
}

export function defaultHeapBytes(memoryLimitBytes: number): number {
  const heap = Math.min(memoryLimitBytes * 0.8, memoryLimitBytes - 512 * MiB);
  const floor = Math.min(256 * MiB, memoryLimitBytes / 2);
  return Math.floor(Math.max(heap, floor) / MiB) * MiB;
}

/** Flags that load code, run commands or replace what the JVM executes. */
const FORBIDDEN_PREFIXES: ReadonlyArray<[string, string]> = [
  ["-javaagent", "loads a Java agent (arbitrary code)"],
  ["-agentlib", "loads a native agent library"],
  ["-agentpath", "loads a native agent library"],
  ["-xx:onoutofmemoryerror", "runs a command on OutOfMemoryError"],
  ["-xx:onerror", "runs a command on a fatal JVM error"],
  ["-xx:vmoptionsfile", "reads further JVM options from a file"],
  ["-xx:flags", "reads further JVM options from a file"],
  ["-xbootclasspath", "changes the boot class path"],
  ["-jar", "changes the launched program"],
  ["-cp", "changes the class path"],
  ["-classpath", "changes the class path"],
  ["--class-path", "changes the class path"],
  ["--module-path", "changes the module path"],
  ["--upgrade-module-path", "changes the module path"],
  ["--patch-module", "patches JDK modules"],
  ["-p", "changes the module path"],
  ["-djava.system.class.loader", "replaces the system class loader"],
  ["-djdk.attach.allowattachself", "allows self-attach of agents"],
  ["-xx:+enabledynamicagentloading", "allows loading agents at runtime"],
  ["-splash", "GUI option"],
];

const HEAP_SIZING = ["-xx:maxrampercentage", "-xx:initialrampercentage", "-xx:minrampercentage", "-xx:maxram="];
const GC_FLAGS = ["-XX:+UseG1GC", "-XX:+UseZGC", "-XX:+UseShenandoahGC", "-XX:+UseParallelGC", "-XX:+UseSerialGC", "-XX:+UseEpsilonGC"];

/** Options that are only forbidden as the whole token (or `--opt=value`), not as a prefix. */
const EXACT_OPTIONS = new Set(["-p", "-cp", "-jar", "-classpath", "--class-path", "--module-path", "--upgrade-module-path", "--patch-module"]);

function forbiddenReason(arg: string): string | null {
  const a = arg.toLowerCase();
  for (const [prefix, why] of FORBIDDEN_PREFIXES) {
    if (EXACT_OPTIONS.has(prefix)) {
      if (a === prefix || a.startsWith(`${prefix}=`)) return why;
    } else if (a.startsWith(prefix)) {
      return why;
    }
  }
  return null;
}

export interface ValidatedJvmArgs {
  args: string[];
  xmx: number | null;
  xms: number | null;
  issues: LaunchIssue[];
}

/** Validates user-supplied JVM arguments. Returns remaining args (heap flags extracted). */
export function validateJvmArgs(extra: readonly string[], memoryLimitBytes: number): ValidatedJvmArgs {
  const issues: LaunchIssue[] = [];
  const args: string[] = [];
  let xmx: number | null = null;
  let xms: number | null = null;
  if (extra.length > 64) issues.push({ code: "INVALID_JVM_ARG", severity: "error", message: "At most 64 JVM arguments are allowed." });
  for (const arg of extra) {
    if (arg.length === 0 || arg.length > 512 || !arg.startsWith("-") || /[\0\r\n]/.test(arg)) {
      issues.push({ code: "INVALID_JVM_ARG", severity: "error", message: "JVM arguments must start with '-' and contain no line breaks (≤ 512 chars).", arg });
      continue;
    }
    const why = forbiddenReason(arg);
    if (why) {
      issues.push({ code: "FORBIDDEN_JVM_FLAG", severity: "error", message: `${arg.split(/[:=]/)[0]} is not allowed: it ${why}.`, arg });
      continue;
    }
    const lower = arg.toLowerCase();
    if (lower.startsWith("-xmx") || lower.startsWith("-xms")) {
      const size = parseJvmSize(arg.slice(4));
      if (size === null) {
        issues.push({ code: "INVALID_JVM_ARG", severity: "error", message: `Cannot parse heap size in ${arg}.`, arg });
        continue;
      }
      if (size > memoryLimitBytes) {
        issues.push({ code: "HEAP_ABOVE_LIMIT", severity: "error", message: `${arg} exceeds the container memory limit (${formatJvmSize(memoryLimitBytes)}).`, arg });
        continue;
      }
      if (lower.startsWith("-xmx")) xmx = size;
      else xms = size;
      continue;
    }
    if (HEAP_SIZING.some((p) => lower.startsWith(p))) {
      issues.push({ code: "HEAP_FLAG_CONFLICT", severity: "error", message: `${arg.split("=")[0]} conflicts with BlockForge's explicit heap size; set the heap size instead.`, arg });
      continue;
    }
    args.push(arg);
  }
  return { args, xmx, xms, issues };
}

export interface LaunchInput {
  software: ServerSoftware;
  artifact: Pick<ResolvedArtifact, "launch" | "java">;
  /** Java major to run (user override already validated), default = runtime for the artifact. */
  javaMajor?: number | null;
  memoryLimitBytes: number;
  heapMaxBytes?: number | null;
  jvmPreset: JvmPreset;
  extraJvmArgs?: readonly string[];
  /** For `jar-candidates` launch targets: the jar that exists after installation. */
  launchJar?: string | null;
  /** IANA time zone for log timestamps / scheduled tasks inside the JVM (sets TZ). */
  timezone?: string | null;
}

export interface LaunchSpec {
  image: string;
  command: string[];
  stopCommand: "stop" | "end";
  env: Record<string, string>;
  heapMaxBytes: number;
  javaMajor: number;
  warnings: LaunchIssue[];
}

function launchArgs(target: LaunchTarget, launchJar: string | null | undefined): string[] | LaunchIssue {
  switch (target.kind) {
    case "jar":
      return ["-jar", target.jar, ...target.programArgs];
    case "argfile":
      return [`@${target.argFile}`, ...target.programArgs];
    case "jar-candidates":
      if (!launchJar || !target.candidates.includes(launchJar)) {
        return { code: "LAUNCH_JAR_UNRESOLVED", severity: "error", message: `Pick the installed jar (one of ${target.candidates.join(", ")}) after installation.` };
      }
      return ["-jar", launchJar, ...target.programArgs];
  }
}

export function stopCommandFor(software: ServerSoftware): "stop" | "end" {
  return software === "velocity" ? "end" : "stop";
}

/** Builds `{image, command, stopCommand, env}`; throws LaunchValidationError on any error. */
export function buildLaunchSpec(input: LaunchInput): LaunchSpec {
  const issues: LaunchIssue[] = [];
  const limit = input.memoryLimitBytes;
  if (!Number.isFinite(limit) || limit < 256 * MiB) {
    throw new LaunchValidationError([{ code: "HEAP_TOO_SMALL", severity: "error", message: "Container memory limit must be at least 256 MiB." }]);
  }
  const user = validateJvmArgs(input.extraJvmArgs ?? [], limit);
  issues.push(...user.issues);

  let heap = input.heapMaxBytes ?? user.xmx ?? defaultHeapBytes(limit);
  if (input.heapMaxBytes != null && user.xmx !== null && user.xmx !== input.heapMaxBytes) {
    issues.push({ code: "HEAP_FLAG_CONFLICT", severity: "error", message: "Set the heap either with heapMaxBytes or with -Xmx, not both with different values." });
  }
  heap = Math.floor(heap / MiB) * MiB;
  if (heap > limit) issues.push({ code: "HEAP_ABOVE_LIMIT", severity: "error", message: `Heap (${formatJvmSize(heap)}) exceeds the container memory limit (${formatJvmSize(limit)}).` });
  else if (limit - heap < 256 * MiB) {
    issues.push({ code: "LOW_HEADROOM", severity: "warning", message: "Less than 256 MiB is left outside the heap; the container may be OOM-killed." });
  }
  if (heap < 128 * MiB) issues.push({ code: "HEAP_TOO_SMALL", severity: "error", message: "Heap must be at least 128 MiB." });
  if (user.xms !== null && user.xms > heap) issues.push({ code: "XMS_ABOVE_XMX", severity: "error", message: "-Xms must not exceed the maximum heap." });

  let presetFlags: string[] = [];
  let xms: number | null = user.xms;
  switch (input.jvmPreset) {
    case "default":
      presetFlags = ["-XX:+UseG1GC"];
      xms ??= Math.min(heap, 1024 * MiB);
      break;
    case "aikar":
      if (!AIKAR_SOFTWARE.includes(input.software)) {
        issues.push({ code: "AIKAR_NOT_APPLICABLE", severity: "error", message: "Aikar's flags are only offered for Paper, Purpur and Folia." });
      } else if (heap < AIKAR_MIN_HEAP_BYTES) {
        issues.push({ code: "AIKAR_NOT_APPLICABLE", severity: "error", message: "Aikar's flags need a heap of at least 4 GiB (PaperMC recommends 6–10 GB)." });
      } else if (heap < 6 * GiB) {
        issues.push({ code: "AIKAR_SMALL_HEAP", severity: "warning", message: "PaperMC recommends at least 6–10 GB of heap for Aikar's flags." });
      }
      presetFlags = [...AIKAR_FLAGS];
      xms ??= heap;
      break;
    case "none":
      break;
  }
  const userGc = user.args.filter((a) => GC_FLAGS.includes(a));
  const presetGc = presetFlags.filter((a) => GC_FLAGS.includes(a));
  if (userGc.length > 1 || (presetGc.length > 0 && userGc.some((g) => !presetGc.includes(g)))) {
    issues.push({ code: "GC_CONFLICT", severity: "error", message: "Only one garbage collector can be selected; use the 'none' preset to choose your own." });
  }

  const target = launchArgs(input.artifact.launch, input.launchJar);
  if (!Array.isArray(target)) issues.push(target);

  const env: Record<string, string> = {};
  if (input.timezone) {
    if (/^[A-Za-z0-9_+-]+(?:\/[A-Za-z0-9_+-]+){0,2}$/.test(input.timezone) && input.timezone.length <= 64) env["TZ"] = input.timezone;
    else issues.push({ code: "INVALID_TIMEZONE", severity: "error", message: `Invalid time zone: ${input.timezone}` });
  }

  if (issues.some((i) => i.severity === "error")) throw new LaunchValidationError(issues);

  const javaMajor = input.javaMajor ?? runtimeMajorFor(input.artifact.java.major);
  const heapFlags = [...(xms !== null ? [`-Xms${formatJvmSize(xms)}`] : []), `-Xmx${formatJvmSize(heap)}`];
  const command = ["java", ...heapFlags, ...presetFlags, ...user.args, ...(target as string[])];
  return {
    image: javaImage(javaMajor),
    command,
    stopCommand: stopCommandFor(input.software),
    env,
    heapMaxBytes: heap,
    javaMajor,
    warnings: issues.filter((i) => i.severity === "warning"),
  };
}

export interface InstallerSpec {
  image: string;
  command: string[];
  env: Record<string, string>;
}

/**
 * One-shot installer container (Forge/NeoForge `--installServer`). Runs in the data root with
 * outbound HTTPS; exit code 0 = success, then check `install.expects`.
 */
export function buildInstallerSpec(artifact: Pick<ResolvedArtifact, "install" | "java">, opts: { memoryLimitBytes: number; javaMajor?: number | null }): InstallerSpec | null {
  if (artifact.install.kind === "none") return null;
  const heap = Math.min(1024 * MiB, defaultHeapBytes(opts.memoryLimitBytes));
  const javaMajor = opts.javaMajor ?? runtimeMajorFor(artifact.java.major);
  return { image: javaImage(javaMajor), command: ["java", `-Xmx${formatJvmSize(heap)}`, ...artifact.install.javaArgs], env: {} };
}
