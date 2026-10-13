# Open work

Everything still to finish, as of 2026-10-12. The per-requirement status lives in `docs/CHECKLIST.md`, review records
in `docs/reviews/`, live evidence in `docs/development/test-node.md`. Update this file whenever an item closes or appears.

**Where things stand:** Phases 0–3 and 4a are signed off. Phase 4b is implemented and verified live on the test node
(Players on running Paper and stopped Vanilla; Plugins & mods: Modrinth search/plan/install, toggle, upload, remove,
rollback, identification, update checks; Paper loads the installed plugin). It is not signed off yet: one cross-model
review's findings are still open (section 1).

## 1. Finish Phase 4b (Plugins & mods, Players) — before sign-off

### 1.1 Control-plane review findings (Grok) — `docs/reviews/2026-10-12-control-plane-phase4b.md`
All reproduced by the reviewer; fixed items are marked (tests in `extensions-review.int.test.ts`), the rest are open:
- **High 1 — fixed:** kept jars are hashed right after the move; every undo/rollback re-hashes and refuses on mismatch
  (left in the keep area, job failed with the reason).
- **High 2 — fixed:** Modrinth rollback downloads to a temporary name and renames without overwriting; undo deletes
  only files the job wrote (digest checked).
- **High 3 — fixed:** file-changing extension work holds `servers.active_operation = 'extensions'` (new additive
  `ServerOperation` value, migration 0006), re-checked at every step; backup/restore/reinstall/delete get the usual 409;
  stop/restart/kill pre-empt it on a running server (the change undoes itself).
- **Known gap (from review round 4, not fixed):** an extension job that still holds its own `extensions` lock keeps
  changing plugin/mod files after the workload crashed, even when the agent's on-failure restart policy restarts it
  (the reconciler follows crashed → starting → running without touching the lock). Proposed: a job notes the
  workload state it started under and stops file operations (fenced undo) once the server is neither stopped nor
  running in the same run it started with.
- **Round 2 (Grok) on these fixes — fixed:** blocker B1 (failed finalize pinned the lock), majors 2–5 (pre-emption,
  journaled digests, kept files always recorded, verify-after-move) and minors 6–11; rounds 3–4 (fenced undo on
  stopped servers only, resumable undo records and cleanup holds); see the review record.
- ~~**High 4:** player action feedback accepts target-less failure lines from other commands.~~ Fixed (Grok round 2
  design, rounds 3–6): a line naming the target decides at once unless a command of the same action that could name
  that target overlapped ours (same target, or a wildcard: selectors, UUIDs, `ban-ip <name>`, invalid arguments make
  every command of that action ambiguous for the 60 s linger — after a console `kick @a` every kick is a 504 for 60 s
  by design); target-less lines only at the end of the window, when they are the
  only feedback and no other console command was possibly answering during the wait (60 s for foreign sends, `save-all`
  until saved); otherwise 504 `no_feedback`. Target-less 26.3 failures now take the full feedback window.
- **Major 5 — fixed:** apply is idempotent (job-derived history ids and keep names, a checkpointed journal, history
  written in the step's completing transaction via the new `ctx.checkpoint`).
- **Major 6 — fixed:** remove/upload-replace store the digest of the file actually kept.
- **Medium 7 — fixed:** history stores the username; migration 0006 rewrites stored e-mail addresses.
- ~~**Medium 8:** Mojang 429 ignores `Retry-After`; no shared Mojang limiter.~~ Fixed: `Retry-After` (seconds or
  HTTP-date, clamped to 15 min, 60 s fallback) and one process-wide `MojangRateLimiter` for every control-plane lookup
  (re-checks block and window after every sleep, round 2).
- **Low L1–L7:**
  - ~~realtime revocation lag (30 s)~~ fixed: role bindings re-read at delivery (1 s cache);
  - `fs.hash` batch length unchecked — fixed;
  - lock check-then-act in synchronous ops — fixed;
  - keep pruning without a prefix check — fixed;
  - ~~unaudited op/deop 403~~ fixed: audited as `authz.denied`;
  - the first scan hides `agent_outdated` — fixed;
  - `artifact.fetch` missing from the capability check — fixed.

### 1.2 Follow-ups from the live run
- ~~Jars found on disk and identified by hash are labelled `source: "modrinth"`.~~ Fixed (code aligned to the
  contract): `source` is provenance — scans never set `modrinth`, identified on-disk files stay `unknown` with the
  `modrinth` ref (updates/rollback re-fetch keyed on the ref), externally changed BlockForge files become `unknown`;
  migration 0007 relabels scan-labelled rows (`installed_at` null); web shows "Unknown" + "Identified on Modrinth".
- ~~Two copies of the same plugin or mod are not flagged.~~ Fixed: `flagDuplicateExtensions` (library) adds a
  `DUPLICATE_ID` problem to every enabled copy of a directory at read time (plugins: warning, case-insensitive with
  spaces as `_`; mods: error unless a client-only Fabric copy); disabled jars do not count; `extensions.updated`
  lists every affected copy. Library, control-plane integration and web tests. Grok review round 1 (2 major +
  minors: stale sibling events, failed hash demoting provenance, rollback stamping/keep preference) fixed.
- ~~Control-plane test "searches and shows projects … maps rate limits to 429" failed once in a full parallel run after
  the rate-limiter change (7486da7).~~ Fixed: the test injects the limiter clock/sleep (fixed clock, no real waits) and
  now also asserts the exact 60 s window and that nothing slept; two full parallel runs green.
- Control-plane test `schedules.int.test.ts` is flaky at a `*/5` minute boundary: `scheduler.tick` claims every due
  row in the shared test database, so when the suite reaches that test on a 5-minute mark `tick()` sees schedules
  from other cases (4 due rows instead of 1). Seen once in a full run (Grok review, 2026-10-13); passes on re-run.
  Fix: inject the scheduler clock or scope `tick()` to the test's schedules.

### 1.3 Not yet verified live
- Player sessions and live join/leave with a real Minecraft client (no client on the LAN test so far).
- Velocity proxy sessions; pre-1.13 `list` output.
- Zip64 jars through the real agent (unit-tested in the agent only).
- Upload completion with `replaceExisting` / `allowIncompatible`.
- ~~A real Modrinth update apply~~ — done 2026-10-13: Chunky 1.4.40 → 1.5.3 through `POST …/extensions/updates/apply`
  (`scripts/e2e/e2e_ext_updates.py`); see "Phase 4b sign-off re-run" in `docs/development/test-node.md`.

### 1.4 Cross-model re-review rounds (policy: fixes of high/major findings get a second look)
- Control-plane fixes for 1.1 → Grok round 2.
- Optional confirmation rounds:
  - web Phase 4b fixes (375e19d) → Codex;
  - agent jar-reader fixes (61669b0) → Codex;
  - library round-2 fixes (7486da7) → Grok round 3.
- Reviews are launched with T3 `delegate_task`, which only works on user-initiated turns. Queue them otherwise.

### 1.5 Sign-off
After 1.1–1.4: re-run `scripts/e2e/e2e_extensions.py`, `scripts/e2e/e2e_ext_updates.py`, `scripts/e2e/e2e_players.py` and
`scripts/e2e/e2e_players_stopped.py` against the test node. Record the evidence, mark the Plugins/mods and Players checklist
lines `[x]`, and move "Current focus" to Phase 5.

## 2. Remaining Phase 3–4 features
- **Config editing with revisions, diff, rollback** (Phase 3, not started).
- **Worlds:** create/upload/import/replace/export, sizes, seeds, with safe shutdown (Phase 4, not started).
- **Software updates with rollback** (Phase 4, not started).
- **Java runtime management:** per-server image/major selection, JVM presets, incompatibility diagnostics. The library
  is done (`packages/minecraft`); control plane + UI pending.
- **Tick performance (TPS/MSPT)** for Paper-family servers (console sampling or companion plugin), listed under known
  limitations.

## 3. Later phases (see `docs/CHECKLIST.md` for details)
- **Phase 5 — Databases & remaining parity:** MySQL/MariaDB database hosts; create/rotate/delete per-server databases.
- **Phase 6 — Velocity & networks:**
  - network creation wizard;
  - proxy provisioning (Fill API);
  - backend registration on internal networks;
  - forwarding secret storage + API (library done);
  - forced hosts CRUD/apply/rollback (library done);
  - topology editor (React Flow) with drafts/diff/apply/rollback;
  - connectivity checks;
  - network ops (rolling restart, maintenance, drain, cross-server player counts);
  - a real routing test through Velocity with a headless client.
- **Phase 6b — Disaster recovery:**
  - backup verification and retention policies;
  - pre-restore recovery point (safety backups exist; formal policy pending);
  - coordinated network backups;
  - DR documentation with RTO/RPO.
- **Phase 7 — Advanced operations:**
  - node drain/maintenance/removal with workload handling;
  - offline migration between nodes;
  - staged updates and approvals;
  - advanced alerts;
  - signed agent self-update;
  - operational reporting.
- **Phase 8 — Security hardening:**
  - STRIDE threat model and authz boundary/secret/dependency reviews;
  - control-plane parts of the security test suite (the agent side is covered).
- **Phase 9 — Performance & production readiness:**
  - load tests against the budgets in `docs/product/pterodactyl-parity.md`;
  - restart/disconnect/interrupted-job recovery tests;
  - multi-replica control plane (LISTEN/NOTIFY command routing);
  - deployment automation + upgrade/rollback docs.
- **Phase 10 — Final acceptance:** E2E workflows 1–17 from spec §27; final docs set and known limitations.

## 4. Checklist reconciliation (stale `[~]` notes)
Several Phase 1–3 lines are still `[~]` with notes such as "not yet run against the control-plane routes" or "not yet
against the real agent". Those notes were written before the integration work and the live end-to-end runs that signed
Phase 3 off. Re-check each against `docs/development/test-node.md` and the review records. Then either mark it `[x]` or
replace the note with the concrete gap. Affected lines:
- **Phase 1–2:**
  - web shell (responsive/keyboard behaviour still unverified in a browser);
  - CI workflow (see 5.2);
  - node enrollment UI;
  - notification adapters.
- **Phase 3:**
  - templates;
  - allocations;
  - ownership/subusers;
  - usernames + SSH keys (the "MFA → keys only" rule needs confirming);
  - startup page;
  - placement scheduler;
  - resource reservations;
  - provision job;
  - lifecycle/reconciler;
  - readiness/crash detection;
  - console;
  - creation wizard;
  - server page;
  - file manager.
- **Phase 6:** forwarding/forced hosts lines are correctly partial (library only).

## 5. Operations and environment

### 5.1 Needs the node owner
- SFTP on the LAN is blocked by the test node's `ufw`. It needs
  `sudo ufw allow from 10.10.10.0/24 to any port 2022 proto tcp` (no passwordless sudo for `game`). SFTP was verified
  through an SSH tunnel instead.

### 5.2 CI on GitHub
- The repository has a GitHub remote (`origin`) and CI runs on every push to `main` and on pull requests.
- The first runs (38323141783, 38323453778) failed for these reasons, all fixed on branch `ci/green-on-github`:
  - `packages/minecraft` real-log fixtures (`test/fixtures/logs/*.log`) were never committed: `.gitignore` has `*.log`.
    They were recaptured 2026-10-12 23:55–23:59 UTC from the official jars (see the fixtures README), and
    `!**/test/fixtures/**/*.log` now keeps them tracked.
  - `packages/eggs` wall-clock assertions (`stripAnsi is linear` < 5 ms) tripped on the slower runner. They now use
    inputs big enough that a backtracking/quadratic implementation needs seconds, with a 1 s ceiling (a growth-ratio
    variant measured 12x locally but 141x on GitHub, where GC dominates).
  - The web "checks for updates" test raced the lazy Updates chunk (`getByRole` → `findByRole`).
  - Found on the PR run (38325460130): the control-plane enrollment test split the token on `_`, but the base64url
    secret may contain `_`; it now parses with `ENROLLMENT_TOKEN_PATTERN` like production.
- The `typescript` job now starts the same stack as local development (`pnpm infra:up`: Postgres with
  `blockforge_test`, VictoriaMetrics with the test flags, HTTPS MinIO) instead of separate service containers, which
  lacked MinIO and the VictoriaMetrics flags.
- Go integration tests need Docker (present on GitHub's Ubuntu runners).

### 5.3 Dev environment notes
- **Moved to macOS (2026-10-12).** Development continues on a Mac (Docker via colima; `docker compose` needs
  `cliPluginsExtraDirs: ["/opt/homebrew/lib/docker/cli-plugins"]` in `~/.docker/config.json`). Two things did not come
  across from the Windows checkout because they were never committed: the gitignored `.data/` directory, including
  the e2e scripts named in 1.5 (`.data/e2e_*.py`), and the minecraft log fixtures (recaptured, see 5.2). The e2e
  scripts were rewritten and committed under `scripts/e2e/` (see its README). `scripts/dev-up.sh --tunnel` /
  `scripts/dev-down.sh` are the macOS/Linux equivalents of the `.ps1` helpers; `dev-up.sh` uses node port 18081 by
  default (`BF_TUNNEL_PORT`), since the Windows workstation may still hold 18080; `dev-down.sh` only signals processes
  it can verify as this checkout's (command line + working directory). The test-node agent was re-enrolled fresh against the Mac control
  plane (old identity backed up on the node in `~/blockforge-agent-identity-windows-20261013`).
- **Start and stop:** `scripts/dev-up.ps1 -Tunnel` starts the control plane and the reverse tunnel to the test node;
  `scripts/dev-down.ps1` stops them, together with the web dev server. Start the web dev server manually:
  `npx vite --port 5173 --strictPort` in `apps/web`, with its pid in `.data/web.pid`.
- **Isolated test database:** parallel control-plane test runs share `blockforge_test`. Use
  `TEST_DATABASE_URL=postgres://blockforge:blockforge-dev-only@127.0.0.1:55432/blockforge_test_orch` (already created)
  for an isolated run.
- **Modrinth/Mojang User-Agent contact:** `MODRINTH_CONTACT`, defaulting to the public URL.
- **API keys:** migration 0004 revoked API keys created before migration 0003; operators recreate them.
- **Agent deploy procedure:** see `docs/development/test-node.md` ("Deploying a new agent build").
