# Review: Minecraft + Velocity libraries

* Author: Claude (Minecraft agent) · Reviewer: Codex gpt-5.6-terra (high) · Date: 2026-10-12 · Scope: `packages/minecraft/**`, `packages/velocity/**`

| # | Sev | Finding | Resolution |
|---|-----|---------|------------|
| 1 | High | Forwarding secret/mode changes use backend-first rollout → login failures / split-brain | Fixed: `planNetworkChanges` detects proxy forwarding mode/secret/online-mode/force-key changes and returns `strategy: "coordinated"` — stop proxy (maintenance), write all files, restart affected backends, start proxy; no dual-secret staging (Velocity/Paper accept one secret). Tests: validator-plan.test.ts |
| 2 | High | Java 8 `-Djava.ext.dirs` / `-Djava.endorsed.dirs` bypass code-loading protections | Fixed: `-Djava.ext.dirs`/`-Djava.endorsed.dirs` and other code/native/config-loading flags forbidden (case-insensitive); `-D` properties now on a tight allowlist, other `-X`/`--` options allowlisted, `-XX` denylist (CRaC, CDS archive, AOT, JVMCI lib). Java 8 tests: launch.test.ts |
| 3 | High | Catalogue fetches don't enforce the upstream host allowlist and follow redirects (SSRF) | Fixed: `getText` enforces `CATALOG_HOSTS.metadata` on every request, uses `redirect: "manual"` and re-validates each hop (max 5); download URLs from upstream JSON checked against `CATALOG_HOSTS.artifacts`. Tests: ssrf.test.ts |
| 4 | High | JVM args with `-D…=secret` persisted in command history | Fixed in contracts: `redactCommandPayload` masks `-D` values (5f857d4) |
| 5 | High | Legacy forwarding on "private" LAN interfaces treated as isolated | Fixed: only unpublished backends on a `bf-*` network shared with the proxy, or `ingressAllowlistVerified`, count as isolated; LAN/loopback bindings → `LEGACY_FORWARDING_WITHOUT_ISOLATION` / `BACKEND_LAN_OFFLINE` errors |
| 6 | High | Invalid topology still yields executable rollout steps | Fixed: any validation error or blocked server → `rollout: []` |
| 7 | High | Required forwarding extensions (FabricProxy-Lite/PCF/BungeeGuard) not enforced in preflight | Fixed: `PlanInput.extensions` (installed Modrinth ids per server); required extensions (`requiredExtensions`) and conflicting ones (`conflictingExtensions`: FabricProxy-Lite, BungeeGuard, BungeeForge) block the plan |
| 8 | High | Forge/NeoForge PCF → `none` leaves forwarding enabled | Fixed: PCF → none writes `forwarding.enabled = false` (also when PCF is installed but has no config yet); tests for modern→none, legacy→none, BungeeGuard |
| 9 | Med | `enforce-secure-profile` not written for legacy/BungeeGuard on 1.19.1+ | Fixed: `enforce-secure-profile` written for 1.19+ (modern = proxy `force-key-authentication`, other modes false); version-aware tests |
| 10 | Med | YAML edits of missing keys re-serialise the whole document | Fixed: velocity YAML edits use the shared source-level editor from `@blockforge/eggs` (in-place scalars, line insertion for missing keys, BOM/CRLF kept) with `fallback: "fail"` — never re-serialised |
| 11 | Med | UTF-8 BOM TOML fails to lex | Fixed: `TomlDocument` keeps a leading BOM out of the lines and writes it back; BOM+CRLF tests |
| 12 | Med | Duplicate serverIds across proxy/backends not validated | Fixed: `DUPLICATE_SERVER_ID` error for plan keys shared by proxy/backends (incl. a backend named `proxy` without serverId) |

Reviewer confirmed: live catalogue smoke test passed (Mojang, Fill, Purpur, Fabric, Forge, NeoForge); no properties injection.
