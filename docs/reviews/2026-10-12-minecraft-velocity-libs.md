# Review: Minecraft + Velocity libraries

* Author: Claude (Minecraft agent) · Reviewer: Codex gpt-5.6-terra (high) · Date: 2026-10-12 · Scope: `packages/minecraft/**`, `packages/velocity/**`

| # | Sev | Finding | Resolution |
|---|-----|---------|------------|
| 1 | High | Forwarding secret/mode changes use backend-first rollout → login failures / split-brain | Minecraft agent — pending |
| 2 | High | Java 8 `-Djava.ext.dirs` / `-Djava.endorsed.dirs` bypass code-loading protections | pending |
| 3 | High | Catalogue fetches don't enforce the upstream host allowlist and follow redirects (SSRF) | pending |
| 4 | High | JVM args with `-D…=secret` persisted in command history | Fixed in contracts: `redactCommandPayload` masks `-D` values (5f857d4) |
| 5 | High | Legacy forwarding on "private" LAN interfaces treated as isolated | pending |
| 6 | High | Invalid topology still yields executable rollout steps | pending |
| 7 | High | Required forwarding extensions (FabricProxy-Lite/PCF/BungeeGuard) not enforced in preflight | pending |
| 8 | High | Forge/NeoForge PCF → `none` leaves forwarding enabled | pending |
| 9 | Med | `enforce-secure-profile` not written for legacy/BungeeGuard on 1.19.1+ | pending |
| 10 | Med | YAML edits of missing keys re-serialise the whole document | pending |
| 11 | Med | UTF-8 BOM TOML fails to lex | pending |
| 12 | Med | Duplicate serverIds across proxy/backends not validated | pending |

Reviewer confirmed: live catalogue smoke test passed (Mojang, Fill, Purpur, Fabric, Forge, NeoForge); no properties injection.
