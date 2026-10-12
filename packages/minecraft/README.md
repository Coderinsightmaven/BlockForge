# @blockforge/minecraft

Pure TypeScript library for Minecraft server software: catalogue adapters, Java runtime mapping,
`server.properties` editing/validation, JVM launch argv, log parsing, EULA and world helpers,
Modrinth plugins/mods, jar metadata parsing and player management.
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
| Console feedback | `stripCommandFeedbackPrefix` / `consoleMessage` (26.3+ `System chat: ` prefix removed; null for player chat, bare text, stack lines and non-server loggers — `isServerLogger`: none, Forge/NeoForge `minecraft/<Class>`, Velocity `com.velocitypowered.*`; used by every event, list and feedback parser), strict `isSaveConfirmation`, `isSaveFailure`, `isSaveOffConfirmation`, `isSaveOnConfirmation`, `isSaveProgress`, `createSaveTracker` (INFO + logger none / `minecraft/MinecraftServer` / `minecraft/DedicatedServer`), `parseWhitelistListOutput`; list/feedback targets re-validated as player names / IPv4 |
| EULA / world | `generateEula`, `isEulaAccepted`, `validateSeed`, `javaStringHashCode`, `validateLevelType`, `validateLevelName`, `WORLD_PRESETS` |
| Provisioning | `buildMinecraftProvisioning(input)` → `{ downloads (artifact.fetch payloads, cache: true), install (Forge/NeoForge `workload.install` payload) | null, workload: WorkloadSpec, files (server.properties, eula.txt, velocity.toml bind), deferredFiles, gamerules, warnings }`; `setVelocityBind` |
| Fetch boundary | Every metadata request and redirect hop must be HTTPS on `CATALOG_HOSTS.metadata` (`redirect: "manual"`, max 5 hops); download URLs taken from upstream JSON must be on `CATALOG_HOSTS.artifacts` (`assertAllowedUrl`, `assertArtifactUrl`; override via `CatalogContext.metadataHosts/artifactHosts`). |
| Modrinth | `ModrinthClient({ fetch, userAgent, cache?, … })` (`modrinthUserAgent(version, contact)` → `BlockForge/<v> (<contact>)`; `rateLimit` = last `X-Ratelimit-*` + `backoffMs`; 429 and an exhausted window → `CatalogError RATE_LIMITED` with `retryAfterMs`); `searchModrinth`, `buildModrinthSearchFacets`, `getModrinthProject`, `listCompatibleVersions`, `pickModrinthVersion`, `planModrinthInstall` → `ModrinthInstallPlan { files: ModrinthPlannedFile[] (dependencies first), alreadyInstalled, optionalDependencies, warnings, installable }`, `modrinthFetchPayload(file, workloadId)` (`artifact.fetch`), `identifyModrinthFiles`, `checkModrinthUpdates`; `MODRINTH_LOADER_PROFILES` / `modrinthLoaderProfile(software)` |
| Jar metadata | `parseJarMetadata({ entryPath: text })` over `EXTENSION_METADATA_ENTRIES`; `parsePluginYml`, `parsePaperPluginYml`, `parseBungeeYml`, `parseVelocityPluginJson`, `parseFabricModJson`, `parseQuiltModJson`, `parseModsToml(text, { neoforge?, manifest? })`, `parseJarManifest` → `ExtensionMetadata`; `jarCompatibility(parsedJar | extensions, software)` → contract `ExtensionCompatibility` shape (`loadable`, `metadataIndex`, `problems[{code, level, message}]` with the contract `ExtensionProblemCode`s); `selectExtensionFiles(dir, fs.list entries)`, `extensionDirFor`, `toggledExtensionPath` (`.jar` ⇄ `.jar.disabled`) |
| Contract converters | `src/contract.ts`: `toContractSearchResult`, `toContractProjectDetails`, `toContractVersionSummary`, `toContractInstallPlan` / `toContractPlannedFile` / `toContractPlanWarning`, `toContractUpdateStatus`, `toContractJarInfo` / `toContractExtensionMetadata`, `toContractSkippedEntries`, `toContractPlayersOverview`, `toContractPlayerFeedback`, `toContractPlayerLookup`, `fromContractPlanRequest` (API `allowPrerelease` default false passed explicitly), `fromContractSearchQuery`; dates → epoch ms, unknown version types → `alpha`, contract length caps — every output is parsed with the contract schema in `test/contract-dtos.test.ts` |
| Players | `parsePlayerList(kind, text)` / `serializePlayerList` (Gson-identical) + `addToWhitelist`, `setOperator`, `banPlayer`, `banIp`, `removeFromPlayerList`, `isBanActive`, `formatBanDate`/`parseBanDate`; `offlinePlayerUuid`, `normalizeUuid`, `isValidPlayerName`, `md5`; `lookupMojangProfile(ctx, name)`, `resolvePlayerProfile(ctx, name, { onlineMode })`; `playerCommands.*` (whitelist/op/deop/ban/pardon/ban-ip/pardon-ip/kick/list/glist), `sanitizeReason`, `parsePlayerListOutput`, `parseVelocityGlist`, `parseCommandFeedback` |

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

## Modrinth (API v2, verified live 2026-10-12)

* Every request and redirect hop must be HTTPS on `api.modrinth.com` (POSTs never follow redirects);
  file URLs must be on `cdn.modrinth.com`; responses are zod-validated (`version_files` maps only
  accept hash keys). Filenames must be a single safe `.jar` path component (no separators,
  Windows-reserved, control, bidi/format or line-separator characters), ≤ 2 GiB.
* Search facets: `project_type:plugin|mod` (matches `all_project_types`; hits still say `mod`),
  loader categories OR-ed, `versions:<mc>` (not for Velocity), `server_side!=unsupported`.
* Loader mapping: Paper `paper|spigot|bukkit`, Purpur adds `purpur`, Folia only `folia`, Spigot
  `spigot|bukkit`, Velocity `velocity` (no game-version filter), Fabric `fabric` (+ `quilt` with a
  `QUILT_ON_FABRIC` warning), Forge `forge`, NeoForge `neoforge`; vanilla (datapacks) is `UNSUPPORTED`.
* Version choice: listed, loader + game version match, full loader match over Quilt-only, release
  over beta over alpha, newest. Update checks send `version_types` so a release is never
  "updated" to a beta (`allowPrerelease` overrides).
* Selection policy (`isSelectableVersion`): loader + game version match, `status: "listed"` (missing
  status = unlisted), known type, release unless prereleases are allowed — for automatic picks and
  for dependency pins (a failing pin → `DEPENDENCY_PIN_IGNORED` + fallback). An explicit root
  `versionId` outside the policy is an error unless `allowIncompatibleVersion`.
* Dependencies: required ones resolved recursively for the same loader/version, cycle-safe,
  bounded by `maxFiles` (32), `maxDepth` (8), 64 entries per version and a per-plan request
  budget; version ids are only fetched for selected dependencies. Two different valid pins of one
  project → `DEPENDENCY_PIN_CONFLICT`; an installed dependency must equal the pin (else it is
  replaced) or, unpinned, be compatible; installed copies without a known version →
  `DEPENDENCY_INSTALLED_UNKNOWN`. `incompatible` against installed or planned projects (both
  directions) → error; `embedded` → info; `optional` → offered (`includeOptional` opts in by
  project or version id); `file_name`-only deps → manual install warning. `error` blocks
  (`installable: false`).
* Files: only the primary file (or the only file), which must be a safe `.jar` (no Windows device
  names), on `cdn.modrinth.com` (normalised href stored), ≤ 2 GiB, with SHA-512 (always the agent
  checksum). Hash lookups only count when the returned version lists the hash. Search drops hits
  without a matching loader and client-only hits (`filteredOut`).
* Rate limits: `ModrinthRateLimiter` (shareable via the `limiter` option) spaces requests when few
  remain, waits for the reset up to `maxWaitMs` (2 s), otherwise `RATE_LIMITED`.

## Players

* `whitelist.json` / `ops.json` / `banned-players.json` / `banned-ips.json`: field names, order,
  `"forever"`, `"(Unknown)"`, `yyyy-MM-dd HH:mm:ss Z` and the Gson settings were read from the 26.3
  server classes; serialisation is byte-identical to Gson 2.14.0 with those settings (tested).
  Edit these files while the server is stopped (a running server overwrites them on its next
  change); for a running server use the console commands (`whitelist reload` re-reads only the
  whitelist).
* Console commands accept only `[A-Za-z0-9_]{1,16}` names and IPv4 addresses (IPv4-mapped IPv6 is
  normalised; vanilla `IpBanList` cuts addresses at the first `:`, so IPv6 bans never match); reasons are collapsed to
  one line (control/format/separator characters → spaces, ≤ 200 characters).
* Output parsers only read the message part of a console line (chat lines `<name> …` never match);
  the control plane should still only parse lines that follow the command it sent.

## Minecraft 26.3 console prefix

`MinecraftServer.sendSystemMessage` logs `System chat: {}` from 26.3 on (checked in the 26.1, 26.2
and 26.3 server jars: only 26.3 has it). It covers command feedback (real Paper and vanilla 26.3
lines in `test/fixtures/console/captured-26.3.json`) and, through
`PlayerList.broadcastSystemMessage`, the join/leave/death/advancement broadcasts. Plain `LOGGER`
lines are unchanged (`Done (…)!`, `… logged in with entity id …`, `UUID of player …`,
`… lost connection: …`, watchdog/crash strings — all present verbatim in the 26.3 classes).
Player chat (`MinecraftServer.logChatMessage`: `<name> …` / `[Not Secure] <name> …`) never
carries the prefix, and `consoleMessage` rejects chat before and after stripping it.

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
* Player list files are Gson-generated (not written by a running server: that needs an accepted
  EULA); `list`/feedback parsing is tested on lines built from the jars' format strings, not on
  captured console output. Paper is assumed to use the vanilla `list` command.
* 26.3 join/leave lines with `System chat: ` are derived from the 26.3 bytecode (vanilla); no
  captured join/leave yet, and Paper's join/leave path is assumed to use the same broadcast.
* Floodgate/Bedrock player names (prefix `.`) are rejected by the name validation.
* Identifying installed jars needs agent support (hashes + jar entry reads; see below); uploads
  that are not on Modrinth are only identified through their metadata files.
* Mojang bulk name lookup (`api.minecraftservices.com`) is not implemented; cache single lookups.

## Contract change requests (for `packages/contracts`)

1. `Checksum.algorithm` / `SoftwareBuild.checksum.algorithm`: add `md5` (value `^[a-f0-9]{32}$`)
   and teach `artifact.fetch` to verify it (Purpur publishes nothing stronger).
2. `SoftwareVersion`: optional `support: "supported" | "deprecated" | "unsupported" | null`,
   `javaSource`, `notes: string[]` (exposed today via the local `CatalogVersion` superset).
3. `SoftwareBuild` (or a new `ResolvedArtifact` DTO): multiple downloads (`role`, `destPath`),
   install plan (installer argv + expected files), launch target (`jar` / `argfile` /
   `jar-candidates`), `requiresNetworkAtFirstStart`.
4. `SoftwareVersion`: a neutral `version` field (proxies are not versioned by Minecraft version).
5. **Modrinth / extensions DTOs** (library types to lift as-is): `ModrinthSearchQuery`,
   `ModrinthSearchHit` / `ModrinthSearchResult`, `ModrinthProjectDetails`,
   `ModrinthVersionSummary`, `ModrinthInstallRequest` (minus `installed`, which the control plane
   fills), `ModrinthInstallPlan` / `ModrinthPlannedFile` / `PlanWarning` (+ `PlanWarningCode`),
   `ModrinthUpdateStatus`, `ModrinthFileIdentity` / `IdentifiedFile`, `ExtensionMetadata` /
   `ExtensionDependency`, `JarCompatibility`, `ExtensionFileCandidate`. `installed_extensions`
   (data-model.md) stores `sha256`; Modrinth identifies by SHA-1/SHA-512, so the row should also keep
   `sha512` (and the plan's `versionId`/`projectId`).
6. **Agent commands** for extension scans: `fs.hash { path, algorithms: ["sha1","sha512"] }` →
   hex digests, and `jar.readEntries { path, entries: EXTENSION_METADATA_ENTRIES, maxBytesPerEntry:
   262144 }` → `{ [entry]: text | null }` (read-only, no extraction to disk, zip-bomb limits).
   Installation uses the existing `artifact.fetch` (`modrinthFetchPayload`); replacement needs
   `fs.delete` of `ModrinthPlannedFile.replaces` after a successful fetch; enable/disable is
   `fs.rename` to `toggledExtensionPath`.
7. **Players DTOs**: `PlayerListKind`, `WhitelistEntry`, `OpEntry`, `PlayerBanEntry`, `IpBanEntry`,
   `PlayerProfile`, `OnlinePlayer` / `PlayerListOutput` / `VelocityGlistOutput`, `CommandFeedback`;
   request bodies `{ name }`, `{ name, reason?, expires? }`, `{ ip | name, reason? }`,
   `{ name, level?, bypassesPlayerLimit? }`.
8. `CatalogError` gained `RATE_LIMITED` (+ `retryAfterMs`): map it to HTTP 429/503 with
   `Retry-After` instead of the generic upstream error.
