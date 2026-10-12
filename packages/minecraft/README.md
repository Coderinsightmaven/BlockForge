# @blockforge/minecraft

Pure TypeScript library for Minecraft server software: catalogue adapters, Java runtime mapping,
`server.properties` editing/validation, JVM launch argv, log parsing, EULA and world helpers.
No filesystem/process access; network only through an injected `fetch` (the control plane owns
timeouts, proxying and SSRF policy). Built with `lib: ES2023 + DOM` and no Node typings, so only
web-standard globals (`fetch`, `TextEncoder`, Web Crypto) are used.

## API overview

| Area | Exports |
|---|---|
| Catalogue | `createCatalog()` → `Record<ServerSoftware, SoftwareAdapter>`; `SoftwareAdapter { info, listVersions(ctx), listBuilds(ctx, version), resolve(ctx, version, build \| null) }`; `CatalogContext { fetch, cache?, ttlMs?, userAgent?, maxResponseBytes?, signal? }`; `ResolvedArtifact` (downloads with checksum + agent-compatible checksum + provenance, Java requirement, install plan, launch target, notes); `CATALOG_HOSTS` (allowlist hints); `CatalogError` codes `UPSTREAM_ERROR / INVALID_UPSTREAM_RESPONSE / NOT_FOUND / UNAVAILABLE / UNSUPPORTED / INVALID_ARGUMENT` |
| Cache | `TtlCache<K,V>` (TTL, max entries, in-flight de-duplication, injectable clock) |
| Versions | `parseMinecraftVersion`, `compareMinecraftVersions`, `sortVersionsDesc`, `isAtLeast`, `compareSemverLike` (handles `1.21.11`, `1.21.11-rc3`, year-based `26.3`, `26.3-rc-3`, `26.4-snapshot-3`) |
| Java | `requiredJavaMajor`, `javaMajorFromTable`, `runtimeMajorFor`, `javaImage` (`eclipse-temurin:<major>-jre`), `selectJavaRuntime`, `javaMajorForClassFileVersion` |
| server.properties | `parseProperties` / `serializeProperties` / `getProperties` / `getProperty` / `setProperties` / `updatePropertiesText` (format-preserving), `escapePropertyKey/Value`, `PROPERTY_SCHEMA`, `validateProperties`, `gameplayToProperties` (incl. 1.21.9+ game rules), `platformProperties`, `redactServerProperties` |
| Launch | `buildLaunchSpec` → `{ image, command, stopCommand, env, heapMaxBytes, javaMajor, warnings }`, `buildInstallerSpec`, `validateJvmArgs`, `defaultHeapBytes`, `AIKAR_FLAGS` |
| Logs | `parseLogLine`, `detectLogLevel`, `detectLogEvents` (ready, player join/leave/login/uuid/disconnect, Velocity proxy connect/switch/disconnect, crash indicators, Java version mismatch, port bind failure, EULA required, Paper TPS), `detectReadiness`, `detectCrashIndicator`, `parsePaperTps`, `tokenizeFormatting` / `stripFormatting` (`§` codes + ANSI → plain segments with style, never HTML) |
| EULA / world | `generateEula`, `isEulaAccepted`, `validateSeed`, `javaStringHashCode`, `validateLevelType`, `validateLevelName`, `WORLD_PRESETS` |
| Provisioning | `buildMinecraftProvisioning(input)` → `{ downloads (artifact.fetch payloads, cache: true), install (Forge/NeoForge `workload.install` payload) | null, workload: WorkloadSpec, files (server.properties, eula.txt, velocity.toml bind), deferredFiles, gamerules, warnings }`; `setVelocityBind` |
| Fetch boundary | Every metadata request and redirect hop must be HTTPS on `CATALOG_HOSTS.metadata` (`redirect: "manual"`, max 5 hops); download URLs taken from upstream JSON must be on `CATALOG_HOSTS.artifacts` (`assertAllowedUrl`, `assertArtifactUrl`; override via `CatalogContext.metadataHosts/artifactHosts`). |

### Install / launch plans

| Software | Download | Checksum | Install | Launch |
|---|---|---|---|---|
| vanilla | Mojang `downloads.server` | SHA-1 (per-version JSON itself SHA-1-verified against the manifest) | — | `java … -jar server.jar nogui` |
| paper, folia | Fill v3 `server:default` | SHA-256 | — (Paperclip downloads the Mojang jar on first start) | `-jar server.jar --nogui` |
| velocity | Fill v3 | SHA-256 | — | `-jar velocity.jar`, stop command `end` |
| purpur | Purpur API v2 `/download` | MD5 only (not agent-verifiable) | — (Paperclip) | `-jar server.jar --nogui` |
| fabric | meta server launcher jar + Mojang server jar pre-placed at `.fabric/server/<mc>-server.jar` | launcher: none published; vanilla jar: SHA-1 | — (launcher fetches libraries on first start) | `-jar fabric-server-launcher.jar nogui` |
| forge ≥ 1.17 | Maven installer | SHA-256 sidecar (fallback SHA-512/SHA-1) | `java -jar forge-<v>-installer.jar --installServer` | `java … @libraries/net/minecraftforge/forge/<v>/unix_args.txt nogui` |
| forge < 1.17 | Maven installer | as above | as above | `-jar` first existing of `forge-<v>.jar`, `forge-<v>-universal.jar` |
| neoforge | Maven installer (`net/neoforged/neoforge`, 1.20.1 from `net/neoforged/forge`) | SHA-256 sidecar | `--installServer` | `@libraries/net/neoforged/neoforge/<v>/unix_args.txt nogui` |
| spigot | — | — | — | `UNSUPPORTED`: no redistributable binary (BuildTools only) |

Forge 1.21.11-61.2.0, NeoForge 21.1.259, Fabric 1.21.11/0.19.5 and Paper 26.3 were installed and
started with exactly these argv in containers on 2026-10-12 (they stop at the EULA check because
BlockForge did not accept the EULA for testing). The Forge installer needed > 10 minutes on a
Docker Desktop bind mount and ~2 minutes on a named volume: give installer jobs a generous timeout.

## Sources of truth (verified 2026-10-11/12)

* Mojang `piston-meta` manifest + per-version JSON — versions, server jar SHA-1, `javaVersion`
  (1.17 → 16, 1.18 → 17, 1.20.5 → 21, 26.1 → 25; 1.6.x has no field; 1.0–1.2.4 and all 61
  old_alpha/old_beta ids have no server download).
* PaperMC Fill API v3 (`fill.papermc.io/v3`, OpenAPI `/openapi.yaml`); the v2 API returns
  `410 Gone` (sunset 2026-07-01). Channels ALPHA/BETA/STABLE/RECOMMENDED, `java.version.minimum`,
  `java.flags.recommended` (Aikar's flags).
* Purpur API v2 (`?detailed=true`; MD5 only; `metadata.type: experimental`; failed builds listed).
* Fabric meta v2; fabric-installer `ServerLauncher.java` / `MinecraftServerDownloader.java`.
* Forge Maven + `promotions_slim.json`; installer `data/run.sh` / `data/unix_args.txt`.
* NeoForged Maven; installer `version.json` `inheritsFrom` for the version mapping
  (`21.1.x` → 1.21.1, `26.3.0.x` → 26.3, `+snapshot-N` builds → `<mc>-snapshot-N`).
* Docker Hub `eclipse-temurin` tags: maintained JRE majors 8/11/17/21/25 (no `16-jre`).
* `server.properties` schema: files written by the 1.14 → 26.3 jars; 1.21.9 moved `pvp`,
  `allow-nether`, `enable-command-block`, `spawn-monsters` to game rules (camelCase ids in
  1.21.9–1.21.10, `minecraft:` snake_case ids from 1.21.11); 26.3 defaults `white-list=true`.
* Log formats: real console output of Velocity 4.2.0, Paper 26.3, Forge, NeoForge, Fabric and
  vanilla; join/leave/ready strings from the 26.3 jar (`en_us.json`, `PlayerList`,
  `DedicatedServer`), Velocity 4.2.0 sources, Paper `TicksPerSecondCommand`.

## JVM option policy

Forbidden (case-insensitive): agents, `-XX:OnError/OnOutOfMemoryError`, option files, boot/class/module path changes, `-m`/`--module`/`--source`, Java 8 `-Djava.ext.dirs`/`-Djava.endorsed.dirs`, `java.library.path`, security/logging config files, CRaC/CDS/AOT/JVMCI files. `-D` properties must be on `SYSTEM_PROPERTY_ALLOWLIST` or start with a software prefix (`paper.`, `Paper.`, `purpur.`, `velocity.`, `fml.`, `forge.`, `neoforge.`, `fabric.log.`); other `-X`/`--` options are allowlisted; `-XX:` tuning is allowed apart from the denylist.

## Known limitations

* Player join/leave/readiness parsing is tested on lines built from verified format strings, not
  on captured gameplay logs (that needs an accepted EULA and a real client).
* Purpur (MD5) and the Fabric launcher jar (no checksum) cannot be verified by the agent yet.
* Spigot is not provisionable. Forge < 1.12.2 legacy installers and NeoForge 1.20.1 are untested.
* Pre-1.19 `level-type` lists and keys older than 1.14 come from documentation, not from jars.
* Forge/NeoForge installers and the Fabric/Paper first start need outbound HTTPS from the
  container (Mojang, maven.minecraftforge.net, maven.neoforged.net, maven.fabricmc.net,
  libraries.minecraft.net) — beyond `CATALOG_HOSTS`, which only covers what the agent fetches.
* `SoftwareVersion.minecraftVersion` carries the Velocity version for the Velocity adapter.

## Contract change requests (for `packages/contracts`)

1. `Checksum.algorithm` / `SoftwareBuild.checksum.algorithm`: add `md5` (value `^[a-f0-9]{32}$`)
   and teach `artifact.fetch` to verify it (Purpur publishes nothing stronger).
2. `SoftwareVersion`: optional `support: "supported" | "deprecated" | "unsupported" | null`,
   `javaSource`, `notes: string[]` (exposed today via the local `CatalogVersion` superset).
3. `SoftwareBuild` (or a new `ResolvedArtifact` DTO): multiple downloads (`role`, `destPath`),
   install plan (installer argv + expected files), launch target (`jar` / `argfile` /
   `jar-candidates`), `requiresNetworkAtFirstStart`.
4. `SoftwareVersion`: a neutral `version` field (proxies are not versioned by Minecraft version).
