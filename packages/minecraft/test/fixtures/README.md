# Test fixtures (captured 2026-10-11/12 UTC)

All fixtures are real upstream responses or real files produced by official server jars, trimmed
where noted. `.gitattributes` marks them `-text` so line endings are never rewritten (some tests
check SHA-1s and byte-for-byte round-trips).

| Path | Source | Trimming |
|---|---|---|
| `mojang/version_manifest_v2.json` | `https://piston-meta.mojang.com/mc/game/version_manifest_v2.json` | `versions` reduced to 16 ids; `sha1` removed from entries whose per-version JSON is trimmed |
| `mojang/versions/{26.3,1.21.11,1.17,1.12.2}.json` | per-version JSON from the manifest URLs | **untrimmed** (SHA-1 matches the manifest) |
| `mojang/versions/*.json` (others) | per-version JSON | only `id/type/time/releaseTime/javaVersion/downloads/…` kept |
| `fill/*.json` | `https://fill.papermc.io/v3/projects/…` (Fill 3.0.0) | version/build lists subset; objects unchanged |
| `fill/v2-sunset.json` | `https://api.papermc.io/v2/projects/paper` (HTTP 410, `sunset: Wed, 1 Jul 2026`) | none |
| `purpur/*.json` | `https://api.purpurmc.org/v2/purpur/…` | `26.3-detailed.json`: last 3 builds, commit text cut to first line |
| `fabric/*.json` | `https://meta.fabricmc.net/v2/versions/{game,loader,installer,loader/1.21.11}` | first entries only; `launcherMeta.libraries` removed |
| `forge/promotions_slim.json` | `https://files.minecraftforge.net/net/minecraftforge/forge/promotions_slim.json` | none |
| `forge/maven-metadata.xml` | `https://maven.minecraftforge.net/net/minecraftforge/forge/maven-metadata.xml` | `<versions>` limited to 26.3, 26.2, 1.21.11, 1.20.1, 1.16.5, 1.7.10 and a 1.12.2 sample |
| `forge/*.sha1`, `*.sha256` | Maven sidecars of `forge-1.21.11-61.2.0-installer.jar` | none |
| `neoforge/maven-metadata.xml`, `neoforge/forge-1.20.1-maven-metadata.xml` | `https://maven.neoforged.net/releases/net/neoforged/{neoforge,forge}/maven-metadata.xml` | `<versions>` subset |
| `properties/vanilla-{26.3,1.21.8,1.20.3}.server.properties`, `vanilla-26.3.eula.txt` | written by the official server jars on first start in a throwaway container (EULA **not** accepted, so the server stopped right after writing them) | 26.3: the randomly generated `management-server-secret` value replaced by a placeholder of the same length |
| `logs/velocity-4.2.0-startup.log` | Velocity 4.2.0 build 30 console, container without network | log4j "local host name" stack traces removed |
| `logs/{paper-26.3,forge-1.21.11-61.2.0,neoforge-21.1.259,fabric-1.21.11-0.19.5}-first-start.log` | console of the first start after installation (Forge/NeoForge via `--installServer` + `@…/unix_args.txt`; Fabric launcher with the SHA-1-verified vanilla jar pre-placed in `.fabric/server/`; Paper via Paperclip) — all stop at the EULA check | tail only; Java stack frames removed (NeoForge keeps its real ANSI colour codes) |
| `logs/vanilla-26.3-no-eula.log` | `logs/latest.log` written by the 26.3 server jar on first start | none (includes a real stack trace) |
| `logs/synthesized-events.md` | **not captured** — documents how the join/leave/ready/TPS sample lines used in tests were built from format strings verified in the jars/sources | — |
| `modrinth/NN-*.json`, `modrinth/routes.json` | Modrinth API v2 (`https://api.modrinth.com/v2`), recorded 2026-10-12 18:56 UTC by running the library itself through a recording `fetch` (search for Paper/Fabric/Velocity/Folia, projects, filtered version lists, `/projects?ids`, `/versions?ids`, `/version/{id}`, `POST /version_files`, `POST /version_files/update` with and without `version_types`, `GET/POST /version_file/{hash}[/update]`, one 404). `routes.json` maps method + URL + request body → status, `X-Ratelimit-*` headers and body file | project `body`/`gallery` removed; `changelog` cut to 200 characters; JSON re-indented |
| `modrinth/scenarios.json` | inputs the recorder derived from the live data (LuckPerms newest/older versions and hashes, WorldEdit 7.4.5, the unknown hash) | — |
| `extensions/*.plugin.yml`, `*.paper-plugin.yml`, `*.velocity-plugin.json`, `*.fabric.mod.json`, `*.mods.toml`, `*.neoforge.mods.toml`, `ferritecore-6.0.1-forge.MANIFEST.MF` | extracted with `unzip -p` from the real jars on cdn.modrinth.com (SHA-1 checked against Modrinth): LuckPerms 5.5.71 (Bukkit, Velocity), WorldGuard 7.0.17, Chunky 1.4.40, squaremap 1.3.12, FancyHolograms 3.0.0-SNAPSHOT.90, FancyNpcs 2.12.1+379, Ledger 1.3.5, FabricProxy-Lite 2.10.1, FerriteCore 6.0.1 (Forge) / 7.0.3 (NeoForge), spark 1.10.53 (Forge) / 1.10.124 (NeoForge) | none (byte-exact, CRLF kept in the manifest) |
| `players/gson-{whitelist,ops,banned-players,banned-ips,empty}.json` | **generated, not captured from a server** (that needs an accepted EULA): `players/Gen.java.txt` writes them with Gson 2.14.0 taken from the 26.3 server bundle, using the server's own settings (`new GsonBuilder().setPrettyPrinting().create()` + `newJsonWriter`, read from `StoredUserList.<clinit>` with `javap`) and the field names/order, `"forever"`, `"(Unknown)"` and `yyyy-MM-dd HH:mm:ss Z` constants read from the 26.3 classes | — |
| `players/lang-26.3-en_us-commands.json`, `lang-1.12.2-en_us-commands.lang` | command feedback strings from `assets/minecraft/lang/en_us.json` (26.3 bundle) / `en_us.lang` (1.12.2 jar), SHA-1-verified server jars | only the `commands.{list,players,whitelist,op,deop,ban,banip,pardon,unban,pardonip,unbanip,kick}.*` and player-argument keys |
| `players/velocity-4.2.0-messages-glist.properties` | `com/velocitypowered/proxy/l10n/messages.properties` of Velocity 4.2.0 build 30 (SHA-256 verified); the per-server line format `[server] (n): a, b` comes from `GlistCommand` bytecode | only the `glist` keys |
| `players/mojang-profile-*.json` | `https://api.mojang.com/users/profiles/minecraft/{Notch,notch,bf_nx_q9z2k7w1}` recorded 2026-10-12 19:04 UTC (200, 200 with canonical capitalisation, 404) | none |
| `console/captured-26.3.json` | real console lines of Paper 26.3 and the vanilla egg (26.3) on the test node, 2026-10-12, via the control-plane console history (committed by the coordinator) | none |
