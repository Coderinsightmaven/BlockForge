# Open work

Everything still to finish, as of 2026-10-12. The per-requirement status lives in `docs/CHECKLIST.md`, review records
in `docs/reviews/`, live evidence in `docs/development/test-node.md`. Update this file whenever an item closes or appears.

**Where things stand:** Phases 0–3 and 4a are signed off. Phase 4b is implemented and verified live on the test node
(Players on running Paper and stopped Vanilla; Plugins & mods: Modrinth search/plan/install, toggle, upload, remove,
rollback, identification, update checks; Paper loads the installed plugin). It is not signed off yet: one cross-model
review's findings are still open (section 1).

## 1. Finish Phase 4b (Plugins & mods, Players) — before sign-off

### 1.1 Control-plane review findings (Grok) — `docs/reviews/2026-10-12-control-plane-phase4b.md`
All open, all reproduced by the reviewer:
- **High 1:** failed-install undo restores the kept jar without re-hashing it. Hash right after the move into the keep
  area, re-hash before every undo/rollback rename, refuse on mismatch.
- **High 2:** Modrinth rollback fetches onto an occupied old filename, and its undo deletes the occupant.
- **High 3:** extension jobs don't take `servers.active_operation`. Backup, restore, reinstall and delete can start
  mid-install; one shared lock is needed, re-checked at each step.
- **High 4:** player action feedback accepts target-less failure lines from other commands. Require the target, else 504
  `no_feedback`.
- **Major 5:** job recovery re-runs the non-idempotent apply step (lost original, double fetch).
- **Major 6:** remove/upload-replace store the scan-time hash as `keptSha512`, so changed jars can't be rolled back.
- **Medium 7:** extension history shows the session user's e-mail to extension viewers (store the username).
- **Medium 8:** Mojang 429 ignores `Retry-After`; no shared Mojang limiter. This touches `packages/minecraft` and the
  control plane.
- **Low L1–L7:**
  - realtime revocation lag (30 s);
  - `fs.hash` batch length unchecked;
  - lock check-then-act in synchronous ops;
  - keep pruning without a prefix check;
  - unaudited op/deop 403;
  - the first scan hides `agent_outdated`;
  - `artifact.fetch` missing from the capability check.

### 1.2 Follow-ups from the live run
- Jars found on disk and identified by hash are labelled `source: "modrinth"`. The contract says found-on-disk =
  `unknown` with a Modrinth ref; decide and align the code or the contract.
- Two copies of the same plugin or mod (e.g. a file-manager copy) are not flagged. Add a compatibility problem;
  Paper refuses ambiguous plugin names.
- Control-plane test "searches and shows projects … maps rate limits to 429" failed once in a full parallel run after
  the rate-limiter change (7486da7). It passes in isolation. Make it deterministic (inject clock/sleep into the limiter).

### 1.3 Not yet verified live
- Player sessions and live join/leave with a real Minecraft client (no client on the LAN test so far).
- Velocity proxy sessions; pre-1.13 `list` output.
- Zip64 jars through the real agent (unit-tested in the agent only).
- Upload completion with `replaceExisting` / `allowIncompatible`, and a real Modrinth update apply (needs an
  outdated plugin installed first).

### 1.4 Cross-model re-review rounds (policy: fixes of high/major findings get a second look)
- Control-plane fixes for 1.1 → Grok round 2.
- Optional confirmation rounds:
  - web Phase 4b fixes (375e19d) → Codex;
  - agent jar-reader fixes (61669b0) → Codex;
  - library round-2 fixes (7486da7) → Grok round 3.
- Reviews are launched with T3 `delegate_task`, which only works on user-initiated turns. Queue them otherwise.

### 1.5 Sign-off
After 1.1–1.4: re-run `.data/e2e_extensions.py`, `.data/e2e_ext_updates.py`, `.data/e2e_players.py` and
`.data/e2e_players_stopped.py` against the test node. Record the evidence, mark the Plugins/mods and Players checklist
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
- The repository has a GitHub remote (`origin`) and CI runs on every push to `main`.
- **First runs fail.** Run 38323141783 (53f81f7):
  - The `node-agent` job is green.
  - The `typescript` job passed install, lint and typecheck, then failed `pnpm test` in `packages/eggs`
    (`test/security.test.ts` › "#4 linear-time regexes" › "stripAnsi is linear": wall-clock ratio 14.1, limit 5).
    GitHub's slower shared runner trips the threshold; this is not a regression.
- **Fix:** make that test (and any other wall-clock assertion) robust. For example, compare growth across input sizes
  with a generous factor, or count steps instead of milliseconds.
- **Still unconfirmed on GitHub:** the remaining packages' tests, `pnpm build` and `bundle:check`, because turbo stops at
  the first failure. The same applies to the control-plane integration tests' service containers.
- After the fix, check that the whole workflow passes, including `pnpm --filter @blockforge/web bundle:check` and the
  fixtures diff.
- Control-plane tests need Postgres, VictoriaMetrics and MinIO (`infra/compose/docker-compose.dev.yml`) plus `openssl`
  on PATH (the safe-fetch transport tests generate a certificate at test time). Make sure the workflow provides these.
- Go integration tests need Docker.

### 5.3 Dev environment notes
- **Start and stop:** `scripts/dev-up.ps1 -Tunnel` starts the control plane and the reverse tunnel to the test node;
  `scripts/dev-down.ps1` stops them, together with the web dev server. Start the web dev server manually:
  `npx vite --port 5173 --strictPort` in `apps/web`, with its pid in `.data/web.pid`.
- **Isolated test database:** parallel control-plane test runs share `blockforge_test`. Use
  `TEST_DATABASE_URL=postgres://blockforge:blockforge-dev-only@127.0.0.1:55432/blockforge_test_orch` (already created)
  for an isolated run.
- **Modrinth/Mojang User-Agent contact:** `MODRINTH_CONTACT`, defaulting to the public URL.
- **API keys:** migration 0004 revoked API keys created before migration 0003; operators recreate them.
- **Agent deploy procedure:** see `docs/development/test-node.md` ("Deploying a new agent build").
