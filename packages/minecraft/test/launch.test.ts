import { describe, expect, it } from "vitest";
import { WorkloadSpec } from "@blockforge/contracts";
import {
  AIKAR_FLAGS,
  LaunchValidationError,
  buildInstallerSpec,
  buildLaunchSpec,
  defaultHeapBytes,
  parseJvmSize,
  validateJvmArgs,
  type LaunchInput,
  type ResolvedArtifact,
} from "../src/index.js";

const MiB = 1024 ** 2;
const GiB = 1024 ** 3;

const paperArtifact: Pick<ResolvedArtifact, "launch" | "java"> = {
  launch: { kind: "jar", jar: "server.jar", programArgs: ["--nogui"] },
  java: { major: 21, source: "upstream", notes: [] },
};

function build(over: Partial<LaunchInput> = {}) {
  return buildLaunchSpec({ software: "paper", artifact: paperArtifact, memoryLimitBytes: 4 * GiB, jvmPreset: "default", ...over });
}

function errorCodes(fn: () => unknown): string[] {
  try {
    fn();
  } catch (e) {
    if (e instanceof LaunchValidationError) return e.issues.filter((i) => i.severity === "error").map((i) => i.code);
    throw e;
  }
  return [];
}

describe("heap sizing", () => {
  it("uses min(limit × 0.8, limit − 512 MiB) with a floor", () => {
    expect(defaultHeapBytes(4 * GiB)).toBe(3276 * MiB);
    expect(defaultHeapBytes(8 * GiB)).toBe(6553 * MiB);
    expect(defaultHeapBytes(2 * GiB)).toBe(1536 * MiB);
    expect(defaultHeapBytes(1 * GiB)).toBe(512 * MiB);
    expect(defaultHeapBytes(512 * MiB)).toBe(256 * MiB);
  });

  it("parses JVM sizes", () => {
    expect(parseJvmSize("4G")).toBe(4 * GiB);
    expect(parseJvmSize("512m")).toBe(512 * MiB);
    expect(parseJvmSize("2048k")).toBe(2 * MiB);
    expect(parseJvmSize("1g2")).toBeNull();
  });
});

describe("buildLaunchSpec", () => {
  it("builds a no-shell argv matching WorkloadSpec", () => {
    const s = build();
    expect(s).toMatchObject({ image: "eclipse-temurin:21-jre", stopCommand: "stop", env: {}, heapMaxBytes: 3276 * MiB, javaMajor: 21 });
    expect(s.command).toEqual(["java", "-Xms1024M", "-Xmx3276M", "-XX:+UseG1GC", "-jar", "server.jar", "--nogui"]);
    const spec = WorkloadSpec.parse({
      workloadId: "6f1c2a7e-8a4b-4c1d-9e2f-0a1b2c3d4e5f",
      kind: "minecraft",
      image: s.image,
      command: s.command,
      env: s.env,
      memoryLimitBytes: 4 * GiB,
      cpuLimitMillicores: null,
      stopCommand: s.stopCommand,
      restartPolicy: { mode: "on-failure" },
    });
    expect(spec.command[0]).toBe("java");
  });

  it("applies Aikar's flags only to Paper-family servers with ≥ 4 GiB heap", () => {
    const s = build({ jvmPreset: "aikar", memoryLimitBytes: 10 * GiB });
    expect(s.command.slice(0, 3)).toEqual(["java", "-Xms8192M", "-Xmx8192M"]);
    expect(s.command).toEqual(expect.arrayContaining([...AIKAR_FLAGS]));
    expect(s.warnings).toEqual([]);
    expect(build({ jvmPreset: "aikar", memoryLimitBytes: 6 * GiB }).warnings.map((w) => w.code)).toEqual(["AIKAR_SMALL_HEAP"]);
    expect(errorCodes(() => build({ jvmPreset: "aikar", memoryLimitBytes: 4 * GiB }))).toEqual(["AIKAR_NOT_APPLICABLE"]);
    expect(errorCodes(() => build({ software: "vanilla", jvmPreset: "aikar", memoryLimitBytes: 16 * GiB }))).toEqual(["AIKAR_NOT_APPLICABLE"]);
    expect(errorCodes(() => build({ software: "fabric", jvmPreset: "aikar", memoryLimitBytes: 16 * GiB }))).toEqual(["AIKAR_NOT_APPLICABLE"]);
  });

  it("rejects command-executing and code-loading JVM flags", () => {
    for (const bad of [
      "-javaagent:/data/evil.jar",
      "-agentlib:jdwp=transport=dt_socket,server=y",
      "-agentpath:/data/x.so",
      "-XX:OnOutOfMemoryError=kill -9 %p",
      "-XX:OnError=sh -c id",
      "-XX:onerror=x",
      "-XX:VMOptionsFile=/data/opts",
      "-Xbootclasspath/a:/data/x.jar",
      "-jar",
      "-cp",
      "--module-path=/data",
      "-Djava.system.class.loader=Evil",
    ]) {
      expect(errorCodes(() => build({ extraJvmArgs: [bad] })), bad).toContain("FORBIDDEN_JVM_FLAG");
    }
    expect(errorCodes(() => build({ extraJvmArgs: ["not-a-flag"] }))).toEqual(["INVALID_JVM_ARG"]);
    expect(errorCodes(() => build({ extraJvmArgs: ["-Dfoo=bar\nbaz"] }))).toEqual(["INVALID_JVM_ARG"]);
  });

  it("rejects heap sizes above the container limit and conflicting heap flags", () => {
    expect(errorCodes(() => build({ extraJvmArgs: ["-Xmx8G"] }))).toEqual(["HEAP_ABOVE_LIMIT"]);
    expect(errorCodes(() => build({ heapMaxBytes: 5 * GiB }))).toEqual(["HEAP_ABOVE_LIMIT"]);
    expect(errorCodes(() => build({ extraJvmArgs: ["-XX:MaxRAMPercentage=90"] }))).toEqual(["HEAP_FLAG_CONFLICT"]);
    expect(errorCodes(() => build({ heapMaxBytes: 2 * GiB, extraJvmArgs: ["-Xmx3G"] }))).toEqual(["HEAP_FLAG_CONFLICT"]);
    expect(errorCodes(() => build({ extraJvmArgs: ["-Xms3G", "-Xmx2G"] }))).toEqual(["XMS_ABOVE_XMX"]);
    const ok = build({ extraJvmArgs: ["-Xmx2G", "-Dpaper.playerconnection.keepalive=60"] });
    expect(ok.command).toEqual(["java", "-Xms1024M", "-Xmx2048M", "-XX:+UseG1GC", "-Dpaper.playerconnection.keepalive=60", "-jar", "server.jar", "--nogui"]);
    expect(build({ heapMaxBytes: 3900 * MiB }).warnings.map((w) => w.code)).toEqual(["LOW_HEADROOM"]);
  });

  it("detects garbage collector conflicts", () => {
    expect(errorCodes(() => build({ extraJvmArgs: ["-XX:+UseZGC"] }))).toEqual(["GC_CONFLICT"]);
    expect(build({ jvmPreset: "none", extraJvmArgs: ["-XX:+UseZGC"] }).command).toEqual(["java", "-Xmx3276M", "-XX:+UseZGC", "-jar", "server.jar", "--nogui"]);
  });

  it("uses `end` for Velocity and the artifact's Java image", () => {
    const s = buildLaunchSpec({
      software: "velocity",
      artifact: { launch: { kind: "jar", jar: "velocity.jar", programArgs: [] }, java: { major: 25, source: "upstream", notes: [] } },
      memoryLimitBytes: 1 * GiB,
      jvmPreset: "default",
    });
    expect(s).toMatchObject({ stopCommand: "end", image: "eclipse-temurin:25-jre" });
    expect(s.command.slice(-2)).toEqual(["-jar", "velocity.jar"]);
  });

  it("launches Forge/NeoForge through the generated args file", () => {
    const s = buildLaunchSpec({
      software: "forge",
      artifact: { launch: { kind: "argfile", argFile: "libraries/net/minecraftforge/forge/1.21.11-61.2.0/unix_args.txt", programArgs: ["nogui"] }, java: { major: 21, source: "mojang", notes: [] } },
      memoryLimitBytes: 6 * GiB,
      jvmPreset: "default",
    });
    expect(s.command.slice(-2)).toEqual(["@libraries/net/minecraftforge/forge/1.21.11-61.2.0/unix_args.txt", "nogui"]);
  });

  it("requires a resolved jar for legacy Forge", () => {
    const artifact = { launch: { kind: "jar-candidates" as const, candidates: ["forge-1.12.2-14.23.5.2859.jar", "forge-1.12.2-14.23.5.2859-universal.jar"], programArgs: ["nogui"] }, java: { major: 8, source: "mojang" as const, notes: [] } };
    expect(errorCodes(() => buildLaunchSpec({ software: "forge", artifact, memoryLimitBytes: 4 * GiB, jvmPreset: "default" }))).toEqual(["LAUNCH_JAR_UNRESOLVED"]);
    const s = buildLaunchSpec({ software: "forge", artifact, memoryLimitBytes: 4 * GiB, jvmPreset: "default", launchJar: "forge-1.12.2-14.23.5.2859-universal.jar" });
    expect(s.image).toBe("eclipse-temurin:8-jre");
    expect(s.command.slice(-3)).toEqual(["-jar", "forge-1.12.2-14.23.5.2859-universal.jar", "nogui"]);
  });

  it("sets TZ only for valid zone names", () => {
    expect(build({ timezone: "Europe/Berlin" }).env).toEqual({ TZ: "Europe/Berlin" });
    expect(errorCodes(() => build({ timezone: "../../etc/passwd" }))).toEqual(["INVALID_TIMEZONE"]);
  });

  it("validates arg counts", () => {
    expect(validateJvmArgs(Array.from({ length: 65 }, (_, i) => `-Dx${i}=1`), 4 * GiB).issues[0]?.code).toBe("INVALID_JVM_ARG");
  });
});

describe("installer spec", () => {
  it("runs the installer with a bounded heap", () => {
    const spec = buildInstallerSpec(
      {
        install: { kind: "installer", javaArgs: ["-jar", "neoforge-26.3.0.76-installer.jar", "--installServer"], expects: [], cleanup: [], requiresNetwork: true, notes: [] },
        java: { major: 25, source: "mojang", notes: [] },
      },
      { memoryLimitBytes: 8 * GiB },
    );
    expect(spec).toEqual({ image: "eclipse-temurin:25-jre", command: ["java", "-Xmx1024M", "-jar", "neoforge-26.3.0.76-installer.jar", "--installServer"], env: {} });
    expect(buildInstallerSpec({ install: { kind: "none" }, java: { major: 21, source: "mojang", notes: [] } }, { memoryLimitBytes: GiB })).toBeNull();
  });
});
