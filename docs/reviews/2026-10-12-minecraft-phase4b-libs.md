# Review: Minecraft Phase 4b libraries (Modrinth, extensions, players, console parsers)

* Author: Claude (Minecraft agent) · Reviewer: Grok grok-4.7 · Date: 2026-10-12 · Scope: `packages/minecraft/**` at 815af5b + 8798386
* Verdict: CHANGES REQUIRED (reviewer ran `pnpm --filter @blockforge/minecraft test`: 283 passed; probes executed against the source)

| # | Sev | Finding | Resolution |
|---|-----|---------|------------|
| 1 | High | `isSaveConfirmation`/`isSaveFailure` accept any line whose text after prefix stripping is `Saved the game` — including bare lines and lines from a named mod/plugin logger (`[Server thread/INFO] [EvilMod]: Saved the game`) → backup archives a world still being written | Open |
| 2 | Major | Same stripping forges `player_join`/leave/disconnect events, op/deop feedback (`Made @a a server operator`) and `list` players (`@a`, `../../ops.json`); captured targets are not re-validated against the player-name grammar | Open |
| 3 | Major | Dependency `version_id` pins skip the listed and `version_type` checks (unlisted alpha installed with `allowPrerelease: false`); missing `status` treated as listed; game-version mismatch on an explicit root `versionId` is only a warning | Open |
| 4 | Major | First resolved pin of a shared dependency wins silently; a later conflicting pin is dropped with no warning | Open |
| 5 | Major | Any installed jar of the project satisfies a required pin (`DEPENDENCY_ALREADY_INSTALLED`), so an old/vulnerable library suppresses the pinned version | Open |
| 6 | Medium | Optional `version_id`-only dependencies are fetched before the selection / `maxFiles` checks (30 optional deps → 30 API calls); rate limiter is per client and does not back off | Open |
| 7 | Medium | When the primary file is not a jar, the planner installs another jar from the list (artifact differs from what Modrinth's download button serves) | Open |
| 8 | Medium | SHA-512 optional (falls back to SHA-1 with an info warning); hash-lookup responses are not checked to actually contain the queried hash before identification/update | Open |
| 9 | Medium | Search maps `loaderMatch: "none"` to `"match"` and does not drop client-only hits (contradicts the code comment) | Open |
| 10 | Low | Metadata `clean()` keeps CR/LF/tab (log-line injection into console-derived text); Modrinth `file_name` interpolated into warnings unsanitised; `fabric.mod.json` `jars[].file` kept with `../` | Open |
| 11 | Low | `isSafeJarFilename` accepts Windows device names (`CON.jar`, `NUL.jar`, `COM1.jar`); `replaces` paths not containment-checked | Open |
| 12 | Low | Fetch payload keeps the raw CDN URL string instead of the WHATWG-normalised `href` checked by the allowlist | Open |
| 13 | Low | `normalizeIp("::ffff:127.0.0.1")` → `::ffff:7f00:1`; bans written in one spelling miss the other | Open |
| 14 | Low | Re-ban without a reason keeps the previous reason; Mojang profile lookup does not require the returned name to match the query | Open |

Test gaps called out: device-name jars, missing SHA-512, conflicting pins, unlisted alpha pins, installed jar vs pin, `version_id` fan-out, hash map not listing the hash, non-primary jar selection, `loaderMatch: "none"`, newline in plugin names, `bundledJars` traversal, `[time] [thread/INFO] [Plugin]: Saved the game`.
