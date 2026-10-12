# @blockforge/eggs

Pure TypeScript library for Pterodactyl/Pelican **eggs**: import (preview + issues), export,
Laravel variable rules, the egg runtime environment, startup display, startup-done matching and the
`config.files` writers (properties / yaml / json / ini / xml / file). No filesystem, process or
network access. Also hosts the shared source-preserving YAML editor used by `@blockforge/velocity`.

## API

| Export | Purpose |
|---|---|
| `parseEgg(raw, { category, game?, imageAllowlist? }) → TemplateImportPreview` | PTDL_v1, PTDL_v2, PLCN_v1/v2/v3. Never throws; any error issue → `template: null`. Output validated with the contract schema. |
| `exportEgg(template, { exportedAt? })` | PTDL_v2 object (Pterodactyl-importable: `config.*` JSON strings, `field_type`, no `sort`). |
| `validateVariableValue(variable, value) → string \| null`, `unsupportedRules(rules)` | Laravel rule subset (`SUPPORTED_VARIABLE_RULES`). |
| `buildEggEnvironment({ template, values, memoryLimitBytes, primary, serverId, location, allocationLimit, timezone })` | `STARTUP` (verbatim), `SERVER_MEMORY` (MiB), `SERVER_IP`, `SERVER_PORT`, `P_SERVER_UUID`, `P_SERVER_LOCATION`, `P_SERVER_ALLOCATION_LIMIT`, `TZ` + every variable (`value ?? default`). |
| `resolveStartupForDisplay(template, values, isViewable)` | `{{VAR}}` → value or `[hidden]`. |
| `applyConfigFileRule(rule, current \| null, ctx: PlaceholderContext) → { content, changed, warnings }` | Never throws for bad file content; `file` parser skips missing files. |
| `createDoneMatcher(patterns)` | Substring / `regex:` matching after ANSI stripping (Wings semantics). |
| `parseImageRef`, `imageAllowed`, `DEFAULT_AGENT_IMAGE_ALLOWLIST` | Port of the agent's image allowlist logic. |
| `yamlSetMany`, `yamlGet`, `yamlMaskPaths` | Source-level YAML editing (in-place scalars, line insertion, BOM/CRLF preserved; `fallback: "fail" \| "reserialize"`). |

## Semantics (sources, verified 2026-10-12)

* **Import**: Pterodactyl `EggImporterService`/`EggParserService` (pterodactyl/panel `1.0-develop` @ `9b97ae11`), Pelican `EggImporterService` (pelican-dev/panel @ `b41ad3e5`): PTDL_v1 `images`/`image` → `docker_images`; PLCN_v3 `startup_commands` (the `Default` entry is used); Pelican rules arrays; `/bin/bash` entrypoints normalised to `bash`; leading `/` in config paths stripped (Wings resolves them inside the server root); reserved names (`RESERVED_ENV_VARS`) rejected (Pelican renames them, Pterodactyl rejects).
* **Stop**: Wings `power.go`: `^C`/`^SIGINT` → SIGINT, `^SIGTERM`, `^SIGKILL`, `^SIGQUIT`; unsupported signals → SIGTERM with a warning.
* **Placeholders**: Pterodactyl `EggConfigurationService` + Wings `LookupConfigurationValue` + Pelican `UPGRADE_VARIABLES` spellings (`TEMPLATE_PLACEHOLDERS`, `TEMPLATE_PLACEHOLDER_PREFIXES`). Unknown placeholders stay as written (Pterodactyl blanks them) and are reported.
* **Config writers**: Wings `parser/parser.go` + `helpers.go` (pterodactyl/wings `develop` @ `5d9e2c34`): dotted paths, `[n]` indices, `*` wildcards, `regex:` conditions (json/yaml), integer coercion (`strconv.Atoi`). Deviations: conditional (map) entries only apply when the current value matches (Wings also writes missing json/yaml paths); every writer preserves the file layout (Wings re-serialises yaml/json/ini/xml/properties); properties escape non-ASCII as `\uXXXX` like Wings.
* **Rules**: Laravel validator semantics — empty values only fail `required`; `boolean` = `"0"`/`"1"`; size rules numeric with `integer`/`numeric`, else character length; PCRE → JS for the common subset (PCRE-only syntax is reported as unsupported).

## Fixtures (`test/fixtures`, captured 2026-10-12)

* `eggs/ptero-*.json` — pterodactyl/panel `database/Seeders/eggs/**` @ `9b97ae113e0524d33e677f905690540afb26bccb` (Minecraft Vanilla/Paper/Forge/BungeeCord/Sponge, Rust, Garry's Mod, Custom Source Engine, TeamSpeak 3, Mumble).
* `eggs/pelican-games-standalone-*.json` — pelican-eggs/games-standalone @ `bded118315af8e1c3df272e7c80c5bc74be77892` (Factorio PTDL_v2 + ARM64 PLCN_v2, Terraria, TShock PLCN_v3, FiveM PLCN_v1, Trackmania PLCN_v2 xml, OpenTTD ini); `eggs/pelican-games-steamcmd-*.json` — pelican-eggs/games-steamcmd @ `8dd208975977aa24a6c53008a65a630c150806b8` (Valheim PTDL_v2 + PLCN_v3). parkervcp/eggs now redirects to these repositories.
* `configs/factorio-server-settings.example.json` — wube/factorio-data @ `374934f8`; `configs/mumble-server.ini` — mumble-voip/mumble `auxiliary_files/mumble-server.ini` @ `0d15773d`; `configs/bungeecord-config.yml` — written by BungeeCord (ci.md-5.net lastSuccessfulBuild, sha256 `176a1a41…`) on first start in a container; `configs/vanilla-26.3.server.properties` — written by the 26.3 server jar. The Trackmania XML in the tests is a representative excerpt (Nadeo's server package is not freely downloadable).
* Opt-in corpus: `EGG_CORPUS_DIR=<dir of egg JSON files> pnpm test` (run once over all 241 eggs of pelican-eggs/{games-standalone,games-steamcmd,minecraft}: 240 import clean, `mordhau-wine` is rejected for a genuinely duplicated `WINDOWS_INSTALL` variable).

## Known limitations

* `config.logs` and `userInteraction` are ignored; egg inheritance (`copy_script_from`/`config_from`) is not supported.
* Non-string `find` values (numbers/booleans) are stored as strings (contract limitation), so JSON/YAML writers coerce them like Wings coerces string values (`"true"` stays a string).
* JSON/YAML writes that cannot be expressed at the source level (e.g. through a flow mapping) fall back to re-serialisation with a warning.
* XML: entities other than the five predefined and numeric references are not expanded; DOCTYPE internal subsets are skipped.
