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
