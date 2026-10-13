# Review: Control plane Phase 4b (Plugins & mods, Players)

* Author: Claude (backend agent) · Reviewer: Grok grok-4.7 (high) · Date: 2026-10-12 · Scope: f8d514d
* Verdict: no blockers; 4 high, 2 major, 2 medium, 7 low — all 8 numbered findings reproduced by executed probes (probe file
  deleted). Reviewer ran the suite once (35 files, 306 tests, pass). Line numbers refer to f8d514d.
* Status: #1, #2, #3, #5, #6, #7, L2, L3, L4, L6, L7 fixed (tests in `apps/control-plane/test/integration/extensions-review.int.test.ts`); #4, #8, L1, L5 fixed (players/Mojang/realtime track, own review rounds below).

| # | Sev | Finding | Resolution |
|---|-----|---------|------------|
| 1 | High | Undo of a failed install renames the kept jar back without hashing it (`extensions/ops.ts:205-211`; same in `service.ts:443`, `jobs.ts:290-292`); `keptSha512` is copied from the scan row. A plugin writing `.blockforge/extensions/kept/` during a slow `artifact.fetch` gets its bytes restored into `plugins/` (executed: `EVIL-KEPT-JAR` restored, original gone). Fix: `fs.hash` right after `keepFile`, store that digest, re-hash before every undo/rollback rename and refuse on mismatch | Fixed — `keepFile` hashes the kept file right after the move and that digest is stored; every undo/rollback rename out of the keep area (`restoreKept`) re-hashes and refuses on mismatch (file left in the keep area, reason in the job error / history, audited for uploads), test: "#1: the undo of a failed install does not restore a kept jar that changed during the download" Round 2: digest taken before the move and verified after; verify-after-move on every restore (items 3–5 below). |
| 2 | High | Modrinth rollback fetches onto `from.path` without an exists check (`jobs.ts:266-278` vs `:282`): an unrelated file now at the old name is overwritten, and on fetch failure the undo deletes it (executed) | Fixed — the Modrinth rollback refuses an occupied `from.path`, downloads to `.blockforge/extensions/fetch/<id>.jar` and renames into place (`fs.rename` never overwrites); undo deletes only files whose digest is still the one it wrote (`deleteCreated`), test: "#2: a Modrinth rollback never overwrites or deletes a file that now has the old name" Round 2: install/update downloads use the same temporary name + verified no-overwrite rename (item 6). |
| 3 | High | Extension jobs hold only `extension_scans.active_job_id`, not `servers.active_operation`: backup, restore, reinstall and delete all start (202) while an install is running; nothing re-checks or aborts the extension job (executed) | Fixed — install/update/rollback jobs and synchronous enable/remove/upload-complete take `servers.active_operation = 'extensions'` (`ServerStateService.lock`, no state change; additive `ServerOperation` value + migration 0006), re-checked before every step and file (`LOCK_LOST`), released by finalize (or after 30 min for a crashed synchronous change); the reconciler keeps following the workload, test: "#3: extension jobs hold the server operation lock against backup, restore, reinstall and delete (and vice versa)" Round 2: stop/restart/kill pre-empt on running servers, stale/terminal-job locks swept and taken over, synchronous holds carry a token (B1, 2, 8, 9). |
| 4 | High | Player action feedback: failure lines match without a target (`Could not op Alex`, `already an operator`, `No player was found`), and `sendAndAwait` takes the first server-logger line — another operator's/late feedback decides the result (executed: `op Steve` → 200 `{ok:false, "Could not op Alex"}` though Steve was opped). Fix: require the target on failures; targetless failures only when nothing else can be in flight; otherwise 504 `no_feedback` | Fixed (round 2 design, see below) — failures carry their target (1.12.2 names it, 26.3 doesn't); a line naming the requested target decides at once unless a command with the same action and target overlapped ours (round 3); target-less lines never end the wait and are accepted only at the end of the window when they are the only feedback and `ConsoleCommandTracker` saw no other command possibly answering at any time during the wait (foreign sends 60 s, `save-all` until the save finished); otherwise 504 `no_feedback`. Tests: `review-cp-phase4b.int.test.ts` (#4 and "#4 round 2" blocks), `test/unit/console-tracker.test.ts`, minecraft `review-cp-phase4b.test.ts` "#4 …" |
| 5 | Major | Job recovery re-runs the non-idempotent apply step (`jobs/runner.ts:359-376`, `extensions/ops.ts:171-177`): a crash after `keepFile` and before `writeHistory` loses the original (kept, no history row) and re-fetches (executed: fetch count 1 → 2). Fix: skip when history for the job exists, skip keep-and-refetch when the destination already has the planned SHA-512, write history atomically with step success | Fixed — history ids and keep names derive from the job id, an already written history is returned as is, a checkpointed journal (`ctx.state`) skips keep and fetch already done (destination has the planned SHA-512), and history is written in the transaction that marks the step succeeded (`ctx.checkpoint(…, { completeStep: true })`), test: "#5: a job resumed after a crash between keep+fetch and the history write neither keeps nor fetches again" Round 2: digests journaled before each move, unjournaled keep files never adopted (item 3); completed steps stay completed (item 7). |
| 6 | Major | Remove stores the scan-time hash as `keptSha512` (`service.ts:203`, `:489`), so a jar changed since the last scan can't be rolled back (`file_unavailable`), and upload-replace of an unscanned path stores null (executed). Same fix as #1 | Fixed — remove and upload-replace store the digest `keepFile` took of the kept file, test: "#6: remove and upload-replace keep the digest of the file actually kept (changed since the scan, or never scanned)" Round 2: hash errors fail before anything moves (item 4). |
| 7 | Medium | Extension history `actor.name` is the session user's e-mail, visible to `servers.extensions.view` holders (`http/auth-hooks.ts:129`, `extensions/model.ts:206-210,238`); store the username like ban sources | Fixed — `historyActor` stores the username (looked up by user id); migration 0006 maps stored e-mail names to usernames and clears the rest, test: "#7: history names the acting user by username; the migration replaces stored e-mail addresses" |
| 8 | Medium | Mojang 429 ignores `Retry-After` (fixed 60 s) and there is no shared Mojang limiter (`packages/minecraft/src/players/mojang.ts:34`, `http.ts:106-108`) | Fixed — `parseRetryAfter` (seconds or HTTP-date, clamped to 15 min, 60 s fallback) and a serialising `MojangRateLimiter` (sliding 600/10 min window, blocks until `Retry-After` after a 429, never refuses while quota remains); re-checked after every sleep (round 2); one instance per process (app.ts) used by every control-plane Mojang lookup, tests: minecraft `review-cp-phase4b.test.ts` "#8 …"; `review-cp-phase4b.int.test.ts` "lookup and list edits share the back-off; seconds and HTTP-date; no request while blocked" |
| L1 | Low | Role revocation of `extensions.updated`/`player.*` delivery lags up to the 30 s principal refresh (`realtime/gateway.ts:15,78-90`) | Fixed — `ServerEventPublisher` re-reads the subscriber's role bindings at delivery (cached 1 s per user; role changes publish no event to invalidate on), test: `test/unit/server-events.test.ts` "a revoked permission stops player events within the short cache TTL…" |
| L2 | Low | `batched()` indexes `fs.hash` results by position without checking the length (`extensions/scan.ts:49-54`) | Fixed — `batched()` refuses an answer whose length or path order differs from the request (`AGENT_PROTOCOL`, scan failed), test: "L2: a hash answer that does not match the requested paths fails the scan cleanly" |
| L3 | Low | Synchronous enable/remove/upload-complete check the extension lock and then act without holding it (`model.ts:142-147`); agent `fs.rename` refuses overwrites, so no silent clobber | Fixed — synchronous changes hold the server's `extensions` lock for their whole duration, taken in one transaction with the (row-locked) extension-job check; scans are refused meanwhile, test: "L3: a synchronous remove holds the lock while it acts (no job, backup or second change starts meanwhile)" Round 2: holder token; re-checked before each file operation (items 2, 8). |
| L4 | Low | Keep-area pruning deletes `kept_path` without a prefix check (`service.ts:562-566`) | Fixed — pruning deletes only normalised paths strictly inside `.blockforge/extensions/kept/`; others are logged and forgotten, test: "L4: pruning never deletes a recorded kept path outside the keep area; …" |
| L5 | Low | The extra `op`/`deop` 403 (missing `servers.console.send`) is not audited (`players/service.ts:236-237`) | Fixed — recorded as `authz.denied` (`permission: servers.console.send`, action, route) like `ServerAccessService.require`, test: `review-cp-phase4b.int.test.ts` "op/deop without servers.console.send → 403 + authz.denied audit event" |
| L6 | Low | The automatic first scan swallows `agent_outdated` (`service.ts:135-137`): the list stays `scan: never` without a reason | Fixed — the list's `scan.error` carries the `agent_outdated` message an explicit scan returns, test: "L6/L7: an outdated agent is reported in the list's scan status, and artifact.fetch is part of the capability check" |
| L7 | Low | `artifact.fetch` is not part of the outdated-agent capability check (`model.ts:101`) | Fixed — `artifact.fetch` added to `EXTENSION_CAPABILITIES`, test: "L6/L7: …" |

Test gaps called out: kept file replaced during fetch; occupied `from.path` on Modrinth rollback; backup/restore/reinstall/delete
while an extension job runs; `recover()` after keep + fetch; server-logger feedback about another player; history `actor.name`;
jar changed between scan and remove; Mojang `Retry-After`.

## Round 2 (Grok grok-4.7, on the round-1 fixes) — CHANGES REQUIRED → fixed

Tests: `apps/control-plane/test/integration/extensions-review.int.test.ts`, describe "Phase 4b review round 2 (Grok)"
(plus the updated #1/#5 tests), `packages/contracts/test/domain.test.ts`, `apps/web/src/features/servers/server-page.test.tsx`.

| # | Sev | Finding | Resolution |
|---|-----|---------|------------|
| B1 | Blocker | A failing finalize pins `active_operation = 'extensions'` forever (both releases in one `finally`; the stale sweep only matched job-less locks; `begin` did not take over a terminal job's lock) | Fixed — each release in its own try; `releaseStaleLocks` also clears locks whose job is terminal or gone (and holder-less ones); `begin`/`lock` take over a lock held by a terminal job, test: "B1: a failing finalize cannot pin the server lock …" |
| 2 | Major | No emergency stop/kill during a plugin/mod change; `LOCK_LOST` skipped the undo | Fixed — contracts (additive): `preemptsExtensions`/`EXTENSIONS_PREEMPTED_BY`, `canStartOperation` lets stop/restart/kill pre-empt `extensions` on running/degraded servers; jobs re-check after every download and at the end, undo and write a failed row on `LOCK_LOST`; synchronous changes re-check by token and undo (409 `preempted`), test: "2: stop and kill pre-empt a running plugin/mod change …" |
| 3 | Major | A crash between keep and journal adopted whatever bytes were in the keep area | Fixed — digest hashed at the source and journaled before the move, verified after it (`keepFile`/`keepJournaled`); on resume only a journaled digest is trusted, otherwise `KEPT_FILE_UNVERIFIED` (non-retryable) with a failed row pointing at the keep path without digest; never restored, test: "3: a resumed job never adopts a kept file whose digest was not journaled before the move" |
| 4 | Major | A failed fetch stranded the kept jar without a history row; `keepFile` swallowed hash errors | Fixed — the entry is recorded as soon as the keep succeeds; failed rows keep `kept_path` + `kept_sha512` when the undo could not restore (pruned later); a hash error fails before anything moves, tests: "#1 …" (row + prune), "4: a file that cannot be hashed is not moved …" |
| 5 | Major | Upload completion hashed, then renamed without re-checking | Fixed — `placeVerified` (verify after the move; moved back and refused on mismatch, 409 `upload_changed`, audited); same verify-after-move in `restoreKept` and `deleteCreated` (moved to a private name and verified before deleting). Residual window: `fs.rename` has no expected-digest parameter, so a swap between hash and rename is detected afterwards, not prevented (agent-side expected-digest rename = possible later improvement), test: "5: staged upload bytes that change between the check and the move are refused" |
| 6 | Minor | Install/update fetched straight onto `destPath` (commit renames over an appeared file) | Fixed — downloads go to `.blockforge/extensions/fetch/<id>.jar`, then a verified no-overwrite rename (refused if occupied), test: "6: an install never renames over a file that appeared …" |
| 7 | Minor | A throw after `checkpoint({ completeStep: true })` marked the step failed | Fixed — nothing fallible after the completing checkpoint (logs moved before it), and the runner treats a step whose completion committed as succeeded |
| 8 | Minor | Stale synchronous release keyed off `updated_at`; `unlock` had no token | Fixed — `servers.operation_token` / `operation_started_at` (migration 0006); `unlock` releases only its own token, the sweep uses `operation_started_at`, test: "2: …" (the pre-empted remove leaves the stop's lock) |
| 9 | Minor | Extension enqueue created the job before locking the server row | Fixed — server row locked first, then the job, then `attachJob` |
| 10 | Minor | Rescan steps did not re-check the lock | Fixed — rescans re-check and fail with `LOCK_LOST` (files already recorded) |
| 11 | Minor | Web: no job banner for `extensions` | Fixed — "Changing plugins/mods" banner, test: "shows a running plugin/mod change …" |
| — | Tests | `keptAreaPath` edge cases; workload exit during an install | Added — "keptAreaPath accepts only files directly inside the keep area", "the reconciler keeps following the workload during a plugin/mod change" |

### Round 3 (Grok grok-4.7, on the round-2 fixes) — CHANGES REQUIRED → fixed

Round 2 verdict: 10 of 11 round-1 items resolved, M1 partially. Tests in the same file (describe "Phase 4b review round 2
(Grok)") plus `packages/contracts/test/domain.test.ts` and `test/integration/jobs.int.test.ts`.

| # | Sev | Finding | Resolution |
|---|-----|---------|------------|
| B | Blocker | After a pre-emption the undo touched files while the new holder was active (restart starting the server; kill releasing the lock so start/backup/install/schedule could overlap) | Fixed — fenced undo (`fencedUndo`): after losing its lock a change may touch plugin/mod files only under a new cleanup hold (`ServerStateService.lockForCleanup`: no live operation, state `stopped`/`crashed`; round 4: `stopped` only), re-checked before every undo step; otherwise nothing is touched, the failed row records every kept file (path + digest) and every written file (path + SHA-512) and the job fails `PREEMPTED_UNDO_SKIPPED`. Same for synchronous changes (409 `preempted_undo_skipped`), tests: "2a: stop/kill with nothing else afterwards …", "2b: while another operation holds the server or it runs …" (restart overlapping the undo, kill then start, kill then backup), "2c: synchronous changes …" (unconditional mid-stop assertion) |
| M | Major | A crash during the undo was not resumed (resumed jobs threw `LOCK_LOST` before reading the journal; undo progress was not journaled) | Fixed — a durable undo record (`UndoLog` in `ctx.state.undo`: every step from the moment it happened, entries, error, attempted/failed steps) checkpointed on every change; on resume a started undo is finished (own lock, else cleanup hold) or deliberately skipped, never the apply; the lock is checked inside the apply, after the journal is read; exactly one failed row, test: "crash during the undo: recover() finishes it under the job's lock, or under a cleanup hold, or skips it …" |
| 1 | Minor | `placeVerified` move-back failure left foreign bytes at the destination, then upload completion restored onto the occupied path | Fixed — `PlacementStuckError` (`FILE_STUCK`); upload completion then never restores onto the destination, records a failed row (kept path + digest) and answers 409 `placement_stuck`, test: "minor 1: a changed upload that cannot be moved back is reported as stuck …" |
| 2 | Minor | `deleteCreated` could orphan a file under `.blockforge/extensions/fetch/<uuid>.delete` silently | Fixed — `FILE_ORPHANED` error naming the quarantine path (ends up in the history row / job error) |
| 3 | Minor | Upload pre-emption put the jar back with a raw rename and swallowed errors | Fixed — the placed upload and the kept file are undo steps (verified helpers, fenced), outcome reported truthfully |
| 4 | Minor | Enable/disable checked the token only before the rename | Fixed — hashed before, re-checked after the rename; pre-empted → fenced rename back (or recorded), test: "2c …" |
| 5 | Minor | A server that crashed during an install stayed blocked for start/restart until the job ended | Fixed — contracts (additive): `EXTENSIONS_PREEMPTED_WHEN_CRASHED_BY`, start/restart pre-empt `extensions` on crashed servers (same fenced undo); domain tests |
| 6 | Minor | The 30-min sweep matched job-less rows regardless of token | Fixed — only token holds whose `operation_started_at` is older than the cutoff (plus holder-less rows); a change that lost its hold to the sweep sees it at the token check and applies the fenced rule |
| 7 | Minor | Migration 0006 edited in place | Kept as one file for this branch; column adds are `ADD COLUMN IF NOT EXISTS` (and the constraint drop `IF EXISTS`) so a dev database with an earlier copy migrates |
| — | Tests | rescan `LOCK_LOST`; throw after `checkpoint({ completeStep: true })` | Added — "rescan: a job that lost its lock after recording the change fails with LOCK_LOST …", "a step whose completing checkpoint committed stays succeeded when it throws afterwards" (jobs.int.test.ts) |

Residual risk: the agent's own restart policy can restart a crashed workload without the control-plane lock
(pre-existing for every operation on crashed servers); a cleanup undo on a `crashed` server can therefore still race
a policy restart.

### Round 4 (Grok grok-4.7, on the round-3 fixes) — no blockers, CHANGES REQUIRED → fixed

Grok confirmed that 2b, 2c, the crash-during-undo test, minor 1 and the crashed start/restart domain case fail on the
round-2 code and pass on round 3. New tests: describe "Phase 4b review round 2 (Grok)" → "round 4: …".

| # | Sev | Finding | Resolution |
|---|-----|---------|------------|
| 1 | Major | Cleanup holds on `crashed` servers race the agent's on-failure restart policy (it restarts the container itself; the reconciler follows without touching the lock), and the fence was checked once per step although `restoreKept` hashes then renames | Fixed — `CLEANUP_STATES = ["stopped"]`; on `crashed` the undo is skipped with full file records (`PREEMPTED_UNDO_SKIPPED`). The fence (`cleanupHeld`: token **and** `state === "stopped"`, or the job's own lock) runs immediately before every `fs.rename`/`fs.delete` inside the helpers (`FileCtx.beforeMutate`); a failed fence stops the undo (`FenceLostError`). Start/restart of a crashed server still pre-empt a running `extensions` job (it then skips its undo), test: "round 4: no cleanup on a crashed server …" |
| 2 | Major | A crash after `lockForCleanup` committed was not resumed and leaked the hold for 30 min | Fixed — the cleanup token is generated by the job and checkpointed in the undo record **before** the hold is taken; on resume a row holding exactly that token is re-adopted (or released if the server is no longer stopped); finalize releases any recorded token, tests: "a crash after the cleanup hold committed …" (hold committed / only recorded; Start works afterwards), "finalize releases a recorded cleanup hold …" |
| m1 | Minor | 2a did not prove the hold | Fixed — 2a asserts `activeOperation: "extensions"` without a job id while the kept jar moves back, and start/backup 409 |
| m2 | Minor | Undo steps not crash-idempotent | Fixed — `restoreKept` treats "keep path gone and destination has the digest" as done; `deleteCreated` takes a quarantine path the undo record journals before the rename and resumes from it, tests: "resume after a restore that completed but was not recorded …", "crash between the quarantine rename and the delete …", "FILE_ORPHANED: …" |
| m3 | Minor | Skipped-undo message claimed "no file was touched" after steps ran; losing the job lock between steps gave up | Fixed — the message lists exactly the undo steps that ran; a lost job lock between steps tries a cleanup hold (stopped only) |
| m4 | Minor | Enable/disable renamed when the hash failed; restore step without `entryId` | Fixed — refused before the rename (409 `hash_failed`); the restore step carries the entry id, test: "round 4: enable/disable refuses a file it cannot hash" |
| m5 | Minor | Cleanup holds invisible in the UI | Fixed — `lockForCleanup` notifies; the server page shows "Changing plugins/mods…" for an `extensions` operation without a job, Start disabled (web test) |
| m6 | Minor | Migration constraint add not idempotent | Fixed — `DROP CONSTRAINT IF EXISTS …, ADD CONSTRAINT …` in one statement |
| m7 | Minor | The install step cleared the journal/undo record before the completing checkpoint | Fixed — `completeStep` clears them inside the completing transaction and restores them in memory if the commit fails (install and rollback) |

Known gap (recorded in OPEN_WORK): an extension job that still holds its own lock keeps changing files after the
workload crashed and the agent's restart policy brought it back (pre-existing).

#### Round 4 minors (Grok: APPROVE WITH MINOR CHANGES) — fixed

Grok verified both round-3 majors and all seven minors resolved (343/343; migration 0006 checked on Postgres 17.11
with the columns present, absent and applied twice). Minors fixed:
1. A quarantine file with non-matching bytes is `FILE_ORPHANED` (only an absent quarantine counts as done);
   `sha512OrAbsent` throws on I/O and other hash errors instead of reading them as "gone". Test: "resume with
   mismatched quarantined bytes → FILE_ORPHANED".
2. Re-adopting a cleanup hold refreshes `operation_started_at` (the 30-min sweep cannot take it mid-undo). Test:
   "a re-adopted hour-old cleanup hold survives the stale-hold sweep during the undo".
3. The fence runs before `fs.mkdir` too (placeVerified, deleteCreated).
4. Comments corrected to "stopped only" (contracts `preemptsExtensions`, service `preemptedSync`).
5. Update history commits with its progress in one checkpoint and the in-memory progress is restored if that commit
   fails. Test: "a failed commit of an update's history: the resumed job writes exactly one history row".
Also tested: finalize releases a cleanup token recorded in the job state without the undo running; a failed
completing commit keeps the journal and undo record persisted. Documented: the lock-check → RPC window (api.md, ops.ts)
and that forward renames re-check after the move with the fenced undo as the repair path.

## Players, Mojang and realtime track (#4, #8, L1, L5)

Reviewed separately from the extension fixes above (same reviewer); round numbers below refer to this track.

### Round 2 (Grok grok-4.7, on the fixes for #4, #8, L1, L5)

Verdict: changes required — 1 blocker, 2 major, 6 minor. All fixed in the same branch:

| # | Sev | Finding | Resolution |
|---|-----|---------|------------|
| R2-1 | Blocker | A target-less failure ended the wait before a later line naming the target (`op Steve` printing "Nothing changed…" then "Made Steve a server operator" → `ok:false`); foreign commands were forgotten 10 s after the send although `save-all` blocks the server thread longer; in-game command output unverified | Fixed — named lines decide at once; target-less lines (feedback and whitelist toggles) only at the end of the window, if they are the only feedback seen and nothing else was possibly answering at any time during the wait (`ConsoleCommandTracker.contended`); foreign commands count for 60 s, `save-all` until "Saved the game"/save failure (+60 s, at most 15 min); the op broadcast of in-game/RCON commands (`[Steve: …]`) is not feedback and failures of such commands are not logged (documented in `parseCommandFeedback`). Tests: "#4 round 2" block in `review-cp-phase4b.int.test.ts` (batch → ok:true; alone → ok:false after the window; foreign during the wait → 504; long save-all → 504 until saved; in-game broadcast ignored), `console-tracker.test.ts`, minecraft "op broadcast … is not feedback" |
| R2-2 | Major | `whitelist-set`/`whitelist-reload` took the first toggle line without the tracker | Fixed — same end-of-window rule; test: "a foreign command sent while we wait … → 504" (toggle part) |
| R2-3 | Major | `MojangRateLimiter.acquire` ignored a `Retry-After` recorded while it slept | Fixed — loops after every sleep, re-checking block and window; test: "round 2: a Retry-After recorded while a caller sleeps extends its wait…" |
| R2-a | Minor | Tracker never pruned on insert, unbounded | Fixed — prune on every insert, ≤ 1 000 entries per server; test: "prunes on insert and bounds the per-server map" |
| R2-b | Minor | Window sleep not re-checked | Fixed by R2-3; test: "round 2: a window sleep that ends early is re-checked…" |
| R2-c | Minor | `rateLimited` returned this response's delay, not the effective block | Fixed — returns the remaining block |
| R2-d | Minor | Fractional seconds and asctime dates rejected | Fixed — decimal seconds (rounded up) and all three RFC 9110 date forms, parsed by hand as UTC; test: "round 2: decimal seconds round up; RFC 850 and asctime dates are UTC" |
| R2-e | Minor | 26.3 kick refusals unrecognised | Fixed — target-less `kick` failures (end-of-window rule); tests: minecraft "26.3 kick refusals…", control plane "… (kick refusals too)" |
| R2-f | Minor | Docs described the round-1 design | Fixed — this section, row #4, OPEN_WORK, api.md |

L1 additionally tested through the real `permissionsOf` (role revocation, subuser removal, ownership transfer;
suspension keeps `.view` permissions by design): "L1 player events follow permission changes at delivery time".

### Round 3 (Grok grok-4.7, on the round-2 fixes)

Verdict: all earlier findings resolved (verified by execution), no blockers; changes required — 1 major, 3 minor. All fixed:

| # | Sev | Finding | Resolution |
|---|-----|---------|------------|
| R3-1 | Major | A named line decided immediately although another overlapping command with the same action and target could have printed it (two `op Steve` waits, a console `op Steve`, or a timed-out attempt's late answer → confident `ok:true`, audited) | Fixed — the tracker keeps each command's (action, target) from `parsePlayerCommand` (own and foreign); an own command is *ambiguous* when another one with the same key was possibly answering at any time during its wait (including our own earlier attempt in its linger); an ambiguous waiter never decides on a named line → 504 `no_feedback` (no success audit). One line therefore never satisfies two waiters. Unrecognised commands (`say`, `list`, plugin commands) don't block; a plugin command printing vanilla-identical feedback could still collide (documented). Tests: "#4 round 3" block (two overlapping `op Steve` → both 504, nothing audited; console `op Steve` during ours → 504; retry during the previous attempt's linger → 504; 1.12.2 "Could not op Steve" then "Opped Steve" → first named line decides, ok:false; `op Steve` + `op Alex` both resolve), `console-tracker.test.ts` "same action and target overlapping → ambiguous", minecraft "parsePlayerCommand" |
| R3-a | Minor | Any save confirmation ended every pending `save-all`, without a progress line | Fixed — `createSaveTracker` semantics: a confirmation counts only after that save's progress line; progress lines and confirmations are matched oldest first, one each; tests: "a stray confirmation before the save's progress line does not end it; one confirmation ends one save" |
| R3-b | Minor | The entry cap could evict a pending `save-all` | Fixed — only expirable entries are evicted, never pending `save-all`s or waiting own commands; test: "the entry cap never evicts a pending save-all or a waiting own command" |
| R3-c | Minor | `Retry-After` "120, 30", "+120" and >10-digit values returned null | Fixed — comma-joined values yield the longest valid element (HTTP-date commas re-joined), signed values rejected (documented), huge digit counts clamp to the max; test: "round 3: comma-joined repeated headers…" |
| R3-d | Minor (test) | The foreign-command integration test depended on a half-window sleep | Fixed — the foreign command is sent before ours with a 60 s linger (deterministic); contention at any point during the wait stays unit-tested |

### Round 4 (Grok grok-4.7, on the round-3 fixes)

Verdict: round-3 behaviour confirmed by execution (overlap cases, first named line, case canonicalisation, save/cap/
Retry-After); whole-wait 60 s ambiguity judged eager but acceptable; changes required — 1 major, 6 minor. All fixed:

| # | Sev | Finding | Resolution |
|---|-----|---------|------------|
| R4-1 | Major | The ambiguity key was not always the target the feedback names: `ban-ip Steve` (resolved to the IP), quoted names (`op "Steve"`), selectors/UUIDs (`kick @a[name=Steve]`) let a foreign line satisfy our waiter (audited) | Fixed — a recognised verb (after `/`, `minecraft:`) always yields its action; the target is the canonical name (quoted names unquoted), a literal IP for `ban-ip`/`pardon-ip`, else the wildcard `*`, which is ambiguous with every command of the same action. Unrecognised verbs (`say`, `list`, plugin commands, `execute … run …`) stay non-blocking; residual documented. Tests: "another spelling of the same command in the console during ours → 504 for success and 1.12.2 named failure, nothing audited" (op/ban quoted, ban-ip name, kick `@a`/selector/UUID), unit "wildcard targets …", minecraft "round 4: a recognised verb always yields its action…" |
| R4-a | Minor | The entry cap could evict a lingering player-command entry | Fixed — only unkeyed expirable entries are evicted; test: "the cap keeps lingering player-command entries…" |
| R4-b | Minor | `minecraft:save-all` was not held | Fixed — optional `/` and `minecraft:` stripped; same test |
| R4-c | Minor | ≤ 1.12 autosave lines can release a pending `save-all` | Documented (same limit as `createSaveTracker`) |
| R4-d | Minor | Retry-After list re-join glued any alphabetic token | Fixed — only a day name, and only if the joined text parses as a date; tests in "round 3: comma-joined…" |
| R4-e | Minor (test) | Overlap tests could pass vacuously | Fixed — 5 s windows vs ≤ 3 s polls; each test asserts the waiter was still open at injection and ran to its deadline |
| R4-f | Minor | A refused console send still lingered 60 s | Fixed — refusals (node not connected, validation, agent errors) drop the entry at once; timeouts and mid-flight disconnects still linger; test: "a send the node refused is forgotten at once; a timed-out one lingers" |

### Round 5 (Grok grok-4.7, on the round-4 fixes)

Verdict: round-4 findings resolved (executed) except the refused-send minor, which introduced 1 major; plus 3 minor. All fixed:

| # | Sev | Finding | Resolution |
|---|-----|---------|------------|
| R5-1 | Major | Post-dispatch console failures were forgotten (RUNTIME_ERROR "write stdin", INTERNAL "agent is shutting down", result-schema VALIDATION_FAILED all reach the server or may have) | Fixed — allowlist: `AgentCommandError.stage` (`not_sent` for control-plane refusals before the frame goes out, `agent_error`, `bad_result`); the entry is dropped only for `not_sent` or agent errors returned before any stdin write (verified in services/node-agent: BUSY, UNSUPPORTED_COMMAND, COMMAND_REJECTED except "duplicate command id …", VALIDATION_FAILED payload/single-line, NOT_FOUND, CONFLICT "not running"); RUNTIME_ERROR, INTERNAL, TIMEOUT, disconnects, bad results and other exceptions linger. An answer decided before the send rejected is returned (and audited) instead of the error. Tests: "round 5: only provably unwritten console sends are forgotten; everything else lingers", "round 5: an answer that arrived before the send failed is returned" |
| R5-a | Minor | api.md/OPEN_WORK did not describe the `*` wildcard | Fixed — both describe it, including `kick @a` → every kick 504 for 60 s by design |
| R5-b | Minor (test) | 14-server overlap test close to the 30 s test timeout | Fixed — explicit 120 s timeout (servers stay sequential: concurrent auto placement would race for ports) |
| R5-c | Minor | MaxListenersExceededWarning with many overlapping waits | Fixed — waiters subscribe through `ConsoleCommandTracker.subscribe` (one gateway `consoleLines` listener) |

### Round 6 (Grok grok-4.7, on the round-5 fixes)

Verdict: round-5 findings resolved (stage marking and every `NEVER_WRITTEN` code verified); changes required — 1 major, 2 minor. All fixed:

| # | Sev | Finding | Resolution |
|---|-----|---------|------------|
| R6-1 | Major | The answer-before-error path returned (and audited) a decided line for every rejection, including ones proving the line was never written | Fixed — returned only for an `AgentCommandError` whose `mayHaveRun` is true; otherwise thrown (no audit). Non-`AgentCommandError`s (the gateway's command-row insert, before dispatch) are thrown and kept lingering for ambiguity (conservative choice). Test: "round 6: an answer decided before an error proving the line was never written is not returned"; the disconnect case still returns ("round 5: an answer that arrived before the send failed is returned") |
| R6-a | Minor | A provably unwritten send result after the feedback window ended left the entry lingering | Fixed — `ConsoleCommandTracker.forget` drops it even after the waiter settled; test: "round 6: a provably unwritten send is forgotten even after the feedback window ended" |
| R6-b | Minor | A throwing waiter in the single `consoleLines` listener skipped the rest of the batch | Fixed — each subscriber runs in try/catch (logged); test: "round 6: a throwing subscriber does not keep the others from the lines" |

The contracts comment of `PlayerActionRequest` (packages/contracts/src/api/players.ts) and api.md describe the final error semantics.
