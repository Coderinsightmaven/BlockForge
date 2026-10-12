import { describe, expect, it } from "vitest";
import { AGENT_COMMANDS, WorkloadSpec } from "@blockforge/contracts";
import {
  FABRIC_META,
  FILL_BASE,
  FORGE_MAVEN,
  FORGE_PROMOTIONS,
  PURPUR_BASE,
  ProvisioningError,
  buildMinecraftProvisioning,
  createFabricAdapter,
  createFillAdapter,
  createForgeAdapter,
  createPurpurAdapter,
  createVanillaAdapter,
  forgeInstallerUrl,
  getProperty,
  isEulaAccepted,
  parseProperties,
  setVelocityBind,
  type MinecraftProvisioningInput,
  type ResolvedArtifact,
} from "../src/index.js";
import { ctxFor, fixture, mojangRoutes } from "./helpers.js";

const GiB = 1024 ** 3;
const ID = "6f1c2a7e-8a4b-4c1d-9e2f-0a1b2c3d4e5f";

const base = (artifact: ResolvedArtifact, over: Partial<MinecraftProvisioningInput> = {}): MinecraftProvisioningInput => ({
  serverId: ID,
  artifact,
  memoryLimitBytes: 4 * GiB,
  cpuLimitMillicores: 2000,
  jvmPreset: "default",
  primary: { ip: "0.0.0.0", port: 25570 },
  timezone: "UTC",
  restartPolicy: { mode: "on-failure", maxRetries: 3, backoffMs: 10_000 },
  acceptEula: true,
  acceptedAt: new Date("2026-10-12T10:00:00Z"),
  acceptedBy: "admin",
  ...over,
});

const vanilla = () => createVanillaAdapter().resolve(ctxFor(mojangRoutes()), "26.3", null);

describe("buildMinecraftProvisioning", () => {
  it("vanilla 26.3: download, workload, server.properties, eula, game rules", async () => {
    const p = buildMinecraftProvisioning(
      base(await vanilla(), {
        additional: [{ ip: "0.0.0.0", port: 25571 }],
        gameplay: { motd: "Hello", pvp: false, maxPlayers: 30, enableCommandBlock: true },
        currentFiles: { "server.properties": fixture("properties/vanilla-26.3.server.properties") },
      }),
    );
    expect(p.downloads).toEqual([
      {
        workloadId: ID,
        url: "https://piston-data.mojang.com/v1/objects/33680f5f2ac32864d6d7cf5e56a705fdb3e05f4c/server.jar",
        destPath: "server.jar",
        checksum: { algorithm: "sha1", value: "33680f5f2ac32864d6d7cf5e56a705fdb3e05f4c" },
        maxBytes: 62294556,
        cache: true,
      },
    ]);
    expect(p.install).toBeNull();
    expect(WorkloadSpec.parse(p.workload)).toEqual(p.workload);
    expect(p.workload).toMatchObject({
      workloadId: ID,
      kind: "minecraft",
      image: "eclipse-temurin:25-jre",
      entrypoint: "argv",
      dataMountPath: "/data",
      stop: { type: "command", command: "stop" },
      memoryLimitBytes: 4 * GiB,
      cpuLimitMillicores: 2000,
      env: { TZ: "UTC" },
    });
    expect(p.workload.command).toEqual(["java", "-Xms1024M", "-Xmx3276M", "-XX:+UseG1GC", "-jar", "server.jar", "nogui"]);
    expect(p.workload.ports).toEqual([
      { containerPort: 25570, hostPort: 25570, hostIp: "0.0.0.0", protocol: "tcp" },
      { containerPort: 25570, hostPort: 25570, hostIp: "0.0.0.0", protocol: "udp" },
      { containerPort: 25571, hostPort: 25571, hostIp: "0.0.0.0", protocol: "tcp" },
      { containerPort: 25571, hostPort: 25571, hostIp: "0.0.0.0", protocol: "udp" },
    ]);
    const props = p.files.find((f) => f.path === "server.properties")!.content;
    const get = (k: string) => getProperty(parseProperties(props), k);
    expect([get("server-port"), get("query.port"), get("server-ip"), get("enable-rcon"), get("enable-query"), get("management-server-enabled")]).toEqual(["25570", "25570", "", "false", "false", "false"]);
    expect([get("motd"), get("max-players"), get("pvp")]).toEqual(["Hello", "30", undefined]);
    expect(props.split("\n").slice(0, 2)).toEqual(fixture("properties/vanilla-26.3.server.properties").split("\n").slice(0, 2));
    expect(isEulaAccepted(p.files.find((f) => f.path === "eula.txt")!.content)).toBe(true);
    expect(p.gamerules).toEqual(["gamerule minecraft:pvp false", "gamerule minecraft:command_blocks_work true"]);
    expect(p.deferredFiles).toEqual([]);
  });

  it("creates server.properties from scratch and writes pvp as a property before 1.21.9", async () => {
    const a = await createVanillaAdapter().resolve(ctxFor(mojangRoutes()), "1.20.4", null);
    const p = buildMinecraftProvisioning(base(a, { gameplay: { pvp: false } }));
    const props = p.files[0]!.content;
    expect(props).toBe("pvp=false\nserver-ip=\nserver-port=25570\nenable-query=false\nenable-rcon=false\nquery.port=25570\n");
    expect(p.gamerules).toEqual([]);
    expect(p.workload.image).toBe("eclipse-temurin:17-jre");
    expect(p.warnings.join(" ")).toMatch(/remaining defaults/);
  });

  it("requires the EULA for game servers", async () => {
    const a = await vanilla();
    expect(() => buildMinecraftProvisioning(base(a, { acceptEula: false }))).toThrow(/EULA must be accepted/);
  });

  it("Paper with Aikar's flags and a SHA-256 cached download", async () => {
    const routes: Record<string, string> = {
      ...mojangRoutes(),
      [`${FILL_BASE}/paper/versions/1.21.11`]: fixture("fill/paper-version-1.21.11.json"),
      [`${FILL_BASE}/paper/versions/1.21.11/builds`]: fixture("fill/paper-1.21.11-builds.json"),
    };
    const a = await createFillAdapter("paper").resolve(ctxFor(routes), "1.21.11", null);
    const p = buildMinecraftProvisioning(base(a, { memoryLimitBytes: 12 * GiB, jvmPreset: "aikar" }));
    expect(p.downloads[0]).toMatchObject({ checksum: { algorithm: "sha256" }, cache: true, maxBytes: 54846016 });
    expect(p.workload.command).toEqual(expect.arrayContaining(["-Xms9830M", "-Xmx9830M", "-XX:G1HeapRegionSize=8M", "-jar", "server.jar", "--nogui"]));
    expect(p.warnings.join(" ")).toMatch(/outbound HTTPS/);
  });

  it("Forge: installer payload for workload.install and argfile launch", async () => {
    const installer = forgeInstallerUrl("1.21.11-61.2.0");
    const routes = {
      ...mojangRoutes(),
      [`${FORGE_MAVEN}/maven-metadata.xml`]: fixture("forge/maven-metadata.xml"),
      [FORGE_PROMOTIONS]: fixture("forge/promotions_slim.json"),
      [`${installer}.sha256`]: fixture("forge/forge-1.21.11-61.2.0-installer.jar.sha256"),
    };
    const a = await createForgeAdapter().resolve(ctxFor(routes), "1.21.11", null);
    const p = buildMinecraftProvisioning(base(a));
    expect(p.downloads[0]).toMatchObject({ destPath: "forge-1.21.11-61.2.0-installer.jar", maxBytes: 512 * 1024 * 1024 });
    expect(p.install).not.toBeNull();
    expect(AGENT_COMMANDS["workload.install"].payload.parse(p.install!.payload)).toMatchObject({ image: "eclipse-temurin:21-jre", entrypoint: "sh", timeoutMs: 45 * 60_000 });
    expect(p.install!.payload.script).toBe("#!/bin/sh\nset -e\ncd /mnt/server\nexec java '-Xmx1024M' '-jar' 'forge-1.21.11-61.2.0-installer.jar' '--installServer'\n");
    expect(p.install!.expects).toEqual(["libraries/net/minecraftforge/forge/1.21.11-61.2.0/unix_args.txt"]);
    expect(p.workload.command.slice(-2)).toEqual(["@libraries/net/minecraftforge/forge/1.21.11-61.2.0/unix_args.txt", "nogui"]);
  });

  it("Fabric and Purpur: warns about downloads the agent cannot verify", async () => {
    const fabric = await createFabricAdapter().resolve(
      ctxFor({
        ...mojangRoutes(),
        [`${FABRIC_META}/installer`]: fixture("fabric/installer.json"),
        [`${FABRIC_META}/loader/1.21.11`]: fixture("fabric/loader-1.21.11.json"),
      }),
      "1.21.11",
      null,
    );
    const pf = buildMinecraftProvisioning(base(fabric));
    expect(pf.downloads.map((d) => [d.destPath, d.checksum?.algorithm ?? null])).toEqual([
      ["fabric-server-launcher.jar", null],
      [".fabric/server/1.21.11-server.jar", "sha1"],
    ]);
    expect(pf.warnings.join(" ")).toMatch(/fabric-server-launcher\.jar has no checksum/);
    const purpur = await createPurpurAdapter().resolve(ctxFor({ ...mojangRoutes(), [`${PURPUR_BASE}/1.21.11/2568`]: fixture("purpur/1.21.11-2568.json") }), "1.21.11", "2568");
    expect(buildMinecraftProvisioning(base(purpur)).warnings.join(" ")).toMatch(/md5 only/);
  });

  it("Velocity: no EULA, `end` stop, bind only once velocity.toml exists", async () => {
    const a = await createFillAdapter("velocity").resolve(
      ctxFor({
        [`${FILL_BASE}/velocity/versions/4.2.0`]: JSON.stringify((JSON.parse(fixture("fill/velocity-versions.json")) as { versions: Array<{ version: { id: string } }> }).versions.find((v) => v.version.id === "4.2.0")),
        [`${FILL_BASE}/velocity/versions/4.2.0/builds`]: fixture("fill/velocity-4.2.0-builds.json"),
      }),
      "4.2.0",
      null,
    );
    const first = buildMinecraftProvisioning(base(a, { acceptEula: false, memoryLimitBytes: GiB }));
    expect(first.workload).toMatchObject({ kind: "velocity", stop: { type: "command", command: "end" }, image: "eclipse-temurin:25-jre" });
    expect(first.files).toEqual([]);
    expect(first.deferredFiles[0]).toMatchObject({ path: "velocity.toml" });
    expect(first.deferredFiles[0]!.reason).toMatch(/0\.0\.0\.0:25570/);
    const toml = fixture("../../../velocity/test/fixtures/default-velocity-4.2.0.toml");
    const second = buildMinecraftProvisioning(base(a, { acceptEula: false, memoryLimitBytes: GiB, currentFiles: { "velocity.toml": toml } }));
    const out = second.files[0]!.content;
    expect(out).toBe(toml.replace('bind = "0.0.0.0:25565"', 'bind = "0.0.0.0:25570"'));
    expect(setVelocityBind(out, "0.0.0.0:25570").changed).toBe(false);
  });

  it("rejects duplicate or too many allocations and invalid JVM args", async () => {
    const a = await vanilla();
    expect(() => buildMinecraftProvisioning(base(a, { additional: [{ ip: "0.0.0.0", port: 25570 }] }))).toThrow(/listed twice/);
    expect(() => buildMinecraftProvisioning(base(a, { additional: Array.from({ length: 8 }, (_, i) => ({ ip: "0.0.0.0", port: 26000 + i })) }))).toThrow(/at most 8/);
    expect(() => buildMinecraftProvisioning(base(a, { jvmArgs: ["-Djava.ext.dirs=/data"] }))).toThrow(ProvisioningError);
    expect(() => setVelocityBind("[servers]\nbind = \"x\"\n", "y")).toThrow(/no root-level/);
  });
});
