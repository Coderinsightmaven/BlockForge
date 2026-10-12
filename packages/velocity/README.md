# @blockforge/velocity

Pure TypeScript library for Velocity networks: a format-preserving `velocity.toml` editor, the
network model → config renderer, forced-host normalisation and DNS guidance, the backend
forwarding compatibility matrix, backend config writers (YAML/TOML/properties), secret
redaction, a structured network validator, and a deterministic change plan with unified diffs.
No filesystem, process or network access.

## API overview

| Area | Exports |
|---|---|
| TOML editor | `TomlDocument.parse(text)`; `get / has / hasTable / keys`; `setValue(table, key, value)` (scalar or string array; inserts when missing); `removeKey`; `ensureTable`; `replaceTableBody(table, entries)`; `validate()` / `data()` (smol-toml). Every untouched byte is preserved; every mutation is validated with smol-toml and rolled back on failure. |
| Model | zod schemas `NetworkModel`, `ProxyNode`, `ProxySettings`, `BackendServer`, `ForcedHostMapping`, `ForwardingMode` (`none/legacy/bungeeguard/modern`), `BackendName` (`try` reserved); `NetworkIssue { severity, code, message, subject }` |
| velocity.toml | `renderVelocityToml(current, model)`, `applyProxySettings`, `applyServers`, `applyForcedHosts`, `formatHostPort` (IPv6 brackets), `configVersion` |
| Secrets | `generateForwardingSecret()` (32 bytes from `crypto.getRandomValues` → 43-char base64url), `assessSecret` (no secret in the result), `forwardingSecretFileContent`, `base64UrlEncode` |
| Forced hosts | `normalizeHostname` (trim, lowercase, trailing dot, IDNA → ASCII via the WHATWG URL parser, RFC 1123, no wildcards), `validateForcedHosts` (duplicates/conflicts after normalisation, empty/unknown/stopped/non-member targets), `dnsGuidance` (A/AAAA/CNAME, SRV for non-default ports, routing caveats) |
| Compatibility | `forwardingCompatibility(software, mcVersion)` → per-mode `{ level: native/plugin/mod/unsupported/unknown, requires, configFiles, steps, notes }`, `recommended`, `requiresOfflineMode`; `supportsForwarding` |
| Backend configs | `backendForwardingFiles(input)` (all file changes for a backend), `writePaperVelocityConfig` (`config/paper-global.yml` ≥ 1.19, `paper.yml` ≤ 1.18.2), `writeSpigotBungeecord`, `writeBungeeGuardConfig`, `writeFabricProxyLiteConfig`, `writePcfConfig`, `editYaml` (in-place scalar splicing; Document API for new keys), `BACKEND_FILES`, `SECRET_BEARING_FILES` |
| Redaction | `redactFileForDisplay(path, text, { knownSecrets, secretFiles })` (structural per file type + generic `*secret*/*token*/*password*` lines + known-value replacement), `redactGenericLines`, `redactKnownSecrets`, `maskYamlPaths`, `REDACTED` |
| Validation | `validateNetwork(model, { secret: SecretAssessment })` → `{ ok, issues, model, forcedHosts }`; `bindExposure(hostIp)` |
| Plan | `planNetworkChanges({ model, current, secret, extensions })` → per server/file `beforeSha256` (for `fs.write ifMatchSha256`), `afterContent`, `afterSha256`, redacted unified `diff`, `sensitive`; per server `action` (`restart` for backends, `reload` = `velocity reload` for the proxy) and `blocked` reasons; `strategy`: `coordinated` when the proxy’s forwarding mode/secret/online-mode/force-key-authentication changes (maintenance-gated: stop proxy → write all files → restart affected backends → start proxy; Velocity and Paper accept a single secret, so no dual-secret staging) or `rolling` otherwise (backends one at a time, then `velocity reload`); `rollout` steps carry a `group` (same group may run concurrently); any validation error, blocked server, missing required extension or installed conflicting extension (`extensions` = installed Modrinth ids per server) empties the rollout; `diffLines` (Myers), `unifiedDiff`, `sha256Hex` |

### Validator issue codes

`NO_PROXY`, `PROXY_BIND_INVALID`, `PROXY_OFFLINE_MODE`, `PROXY_NOT_PUBLISHED`, `FORWARDING_DISABLED`,
`BUNGEEGUARD_FORWARDING`, `SECRET_MISSING`, `SECRET_WEAK`, `NO_BACKENDS`, `INVALID_BACKEND_NAME`,
`MODEL_INVALID`, `DUPLICATE_BACKEND_NAME`, `DUPLICATE_BACKEND_ADDRESS`, `BACKEND_IS_PROXY`,
`BACKEND_PUBLIC_OFFLINE`, `BACKEND_PUBLICLY_REACHABLE`, `BACKEND_ONLINE_MODE`, `FORWARDING_UNSUPPORTED`,
`FORWARDING_SUPPORT_UNKNOWN`, `FORWARDING_REQUIRES_EXTENSION`, `LEGACY_FORWARDING_WITHOUT_ISOLATION`,
`LEGACY_FORWARDING_INSECURE`, `MIXED_MINECRAFT_VERSIONS`, `NO_DEFAULT_SERVER`, `TRY_TARGET_UNKNOWN`,
`TRY_DUPLICATE`, `TRY_TARGET_NOT_IN_NETWORK`, `TRY_TARGET_DOWN`, `DUPLICATE_HOST_PORT`, `DUPLICATE_SERVER_ID`, `BACKEND_LAN_OFFLINE`, and from
forced hosts `FORCED_HOST_INVALID`, `FORCED_HOST_WILDCARD`, `FORCED_HOST_DUPLICATE`,
`FORCED_HOST_CONFLICT`, `FORCED_HOST_NO_TARGETS`, `FORCED_HOST_UNKNOWN_TARGET`,
`FORCED_HOST_DUPLICATE_TARGET`, `FORCED_HOST_TARGET_NOT_IN_NETWORK`, `FORCED_HOST_TARGET_DOWN`,
`FORCED_HOST_NOTE`.

## Sources of truth (verified 2026-10-11)

* Velocity 4.2.0 (Fill build 30) `default-velocity.toml` (config-version 2.9) — identical in the
  jar, the repo at release commit `c10b4925`, and the file Velocity wrote on first start.
* Velocity 4.2.0 sources: `VelocityConfiguration` (lowercased forced-host keys, `validate()`
  rules, `try` reserved, secret read via `String.join("", readAllLines)`, `VELOCITY_FORWARDING_SECRET`
  env), config migrations keyed on `config-version` (why velocity.toml is never generated from
  scratch), `ConnectedPlayer#getNextServerToTry` (exact lowercase vhost lookup, no wildcards),
  `HandshakeSessionHandler.cleanVhost` (NUL cut, trailing-dot strip for SRV),
  `VelocityServer#reloadConfiguration` (reload re-reads servers, forced hosts, secret, bind, query).
* docs.papermc.io/velocity/player-information-forwarding; PaperMC docs config specs
  (`proxies.velocity.*`, `settings.velocity-support.*`, `settings.bungeecord`).
* FabricProxy-Lite README + Modrinth (1.16.5 – 26.3); Proxy Compatible Forge (Modrinth, Forge
  1.7.2 – 26.2 / NeoForge 1.20.1 – 26.2, `config/proxy-compatible-forge.toml`); NeoVelocity
  (NeoForge 1.21 – 1.21.11).

Isolation: a backend counts as reachable only by the proxy when it is not published and shares a `bf-*` network with the proxy, or when an operator verified an ingress allowlist (`ingressAllowlistVerified`). LAN, private and loopback bindings are not isolation. YAML is edited through `@blockforge/eggs`’ source-level editor and never re-serialised (fail closed); TOML and YAML keep a UTF-8 BOM and CRLF.

## Known limitations

* `paper-global.yml` / `spigot.yml` test fixtures are representative (Paper only writes them after
  the EULA is accepted); YAML edits are verified for comment/format preservation on those files.
* Writing `paper-global.yml`, FabricProxy-Lite or PCF configs *from scratch* (before the server
  generated them) relies on the server filling the remaining defaults on start — documented by
  FabricProxy-Lite, not verified for Paper/PCF.
* `enforce-secure-profile` guidance for legacy/BungeeGuard forwarding is advisory, not verified on
  every version. Forge/NeoForge 26.3 forwarding is reported as `unknown` (no PCF release yet).
* Forced hosts: whether a client sends the Unicode or the punycode form of an IDN host was not
  verified; the ASCII form is stored and a warning is emitted.
* The plan does not install plugins/mods (FabricProxy-Lite, PCF, BungeeGuard); it lists them.
* SHA-256 values are computed from the UTF-8 text supplied by the caller; use the agent's
  `fs.read` hash for `ifMatchSha256` when the file may not be valid UTF-8.
