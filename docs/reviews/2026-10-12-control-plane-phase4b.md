# Review: Control plane Phase 4b (Plugins & mods, Players)

* Author: Claude (backend agent) · Reviewer: Grok grok-4.7 (high) · Date: 2026-10-12 · Scope: f8d514d
* Verdict: no blockers; 4 high, 2 major, 2 medium, 7 low — all 8 numbered findings reproduced by executed probes (probe file
  deleted). Reviewer ran the suite once (35 files, 306 tests, pass). Line numbers refer to f8d514d.
* Status: **all open** (to be fixed before Phase 4b sign-off).

| # | Sev | Finding | Resolution |
|---|-----|---------|------------|
| 1 | High | Undo of a failed install renames the kept jar back without hashing it (`extensions/ops.ts:205-211`; same in `service.ts:443`, `jobs.ts:290-292`); `keptSha512` is copied from the scan row. A plugin writing `.blockforge/extensions/kept/` during a slow `artifact.fetch` gets its bytes restored into `plugins/` (executed: `EVIL-KEPT-JAR` restored, original gone). Fix: `fs.hash` right after `keepFile`, store that digest, re-hash before every undo/rollback rename and refuse on mismatch | Open |
| 2 | High | Modrinth rollback fetches onto `from.path` without an exists check (`jobs.ts:266-278` vs `:282`): an unrelated file now at the old name is overwritten, and on fetch failure the undo deletes it (executed) | Open |
| 3 | High | Extension jobs hold only `extension_scans.active_job_id`, not `servers.active_operation`: backup, restore, reinstall and delete all start (202) while an install is running; nothing re-checks or aborts the extension job (executed) | Open |
| 4 | High | Player action feedback: failure lines match without a target (`Could not op Alex`, `already an operator`, `No player was found`), and `sendAndAwait` takes the first server-logger line — another operator's/late feedback decides the result (executed: `op Steve` → 200 `{ok:false, "Could not op Alex"}` though Steve was opped). Fix: require the target on failures; targetless failures only when nothing else can be in flight; otherwise 504 `no_feedback` | Open |
| 5 | Major | Job recovery re-runs the non-idempotent apply step (`jobs/runner.ts:359-376`, `extensions/ops.ts:171-177`): a crash after `keepFile` and before `writeHistory` loses the original (kept, no history row) and re-fetches (executed: fetch count 1 → 2). Fix: skip when history for the job exists, skip keep-and-refetch when the destination already has the planned SHA-512, write history atomically with step success | Open |
| 6 | Major | Remove stores the scan-time hash as `keptSha512` (`service.ts:203`, `:489`), so a jar changed since the last scan can't be rolled back (`file_unavailable`), and upload-replace of an unscanned path stores null (executed). Same fix as #1 | Open |
| 7 | Medium | Extension history `actor.name` is the session user's e-mail, visible to `servers.extensions.view` holders (`http/auth-hooks.ts:129`, `extensions/model.ts:206-210,238`); store the username like ban sources | Open |
| 8 | Medium | Mojang 429 ignores `Retry-After` (fixed 60 s) and there is no shared Mojang limiter (`packages/minecraft/src/players/mojang.ts:34`, `http.ts:106-108`) | Open (library + control plane) |
| L1 | Low | Role revocation of `extensions.updated`/`player.*` delivery lags up to the 30 s principal refresh (`realtime/gateway.ts:15,78-90`) | Open |
| L2 | Low | `batched()` indexes `fs.hash` results by position without checking the length (`extensions/scan.ts:49-54`) | Open |
| L3 | Low | Synchronous enable/remove/upload-complete check the extension lock and then act without holding it (`model.ts:142-147`); agent `fs.rename` refuses overwrites, so no silent clobber | Open |
| L4 | Low | Keep-area pruning deletes `kept_path` without a prefix check (`service.ts:562-566`) | Open |
| L5 | Low | The extra `op`/`deop` 403 (missing `servers.console.send`) is not audited (`players/service.ts:236-237`) | Open |
| L6 | Low | The automatic first scan swallows `agent_outdated` (`service.ts:135-137`): the list stays `scan: never` without a reason | Open |
| L7 | Low | `artifact.fetch` is not part of the outdated-agent capability check (`model.ts:101`) | Open |

Test gaps called out: kept file replaced during fetch; occupied `from.path` on Modrinth rollback; backup/restore/reinstall/delete
while an extension job runs; `recover()` after keep + fetch; server-logger feedback about another player; history `actor.name`;
jar changed between scan and remove; Mojang `Retry-After`.
