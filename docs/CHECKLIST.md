# BlockForge Requirements Checklist

Source of truth for progress against `docs/spec/MASTER_PROMPT.md`. Update in the same change
that implements/tests a requirement. Status keys:
`[ ]` not started · `[~]` in progress / partial · `[x]` implemented **and tested** ·
`[!]` blocked or limited (see note) · `[-]` intentionally deferred (see note).

**Resume point:** see "Current focus" at the bottom.

## Phase 0 — Assessment & architecture
- [x] Repository assessment (`docs/architecture/overview.md` §1)
- [x] Architecture & module boundaries (`overview.md`)
- [x] Agent protocol (`agent-protocol.md`)
- [x] Data model (`data-model.md`)
- [x] Security assumptions (`docs/security/threat-model.md`)
- [x] Shared contracts package (`packages/contracts`) with golden agent fixtures
- [x] Testing & review policy (`docs/development/workflow.md`)

## Phase 1 — Foundation
- [ ] pnpm/turbo monorepo, TS strict, lint/format, vitest
- [ ] docker compose: Postgres 17, VictoriaMetrics
- [x] Control plane skeleton: config, pino logging w/ redaction, request IDs, error format, health endpoints, graceful shutdown — `apps/control-plane` (`buildApp` factory + `main.ts`); booted via `dev` and from `dist/`, `/healthz` + `/readyz` (DB, migrations, VictoriaMetrics) verified; shutdown closes agents with 1012 (integration test). SIGTERM handling itself only exercised through `app.close()` (Windows host).
- [x] Drizzle schema + migrations (identity, nodes, servers, networks, jobs, audit, secrets, events) — all data-model.md tables incl. alerts/notifications, `agent_auth_jti`, `idempotency_keys`, `network_try_servers`/`forced_host_targets`; text+CHECK enums from contracts; advisory-locked migrator. `backups`/`backup_policies`/`schedules`/`schedule_runs` deferred to Phases 4/6 (no columns specified yet).
- [x] First-run owner setup (one-time setup token)
- [x] Auth: argon2id login/logout, sessions, CSRF, rate limits, lockout — session-bound CSRF hash, Origin + JSON content-type on login/setup, per-IP route limit + per-email limiter, progressive lockout, idle/absolute expiry, password change revokes other sessions.
- [x] TOTP MFA enrol/verify/disable — encrypted secret, replay-protected time steps, MFA gate, session rotation on verify, 5-failure session revocation.
- [x] RBAC: built-in roles, scoped bindings, `authorize()` + tests — idempotent role reconciliation (removes stale permissions, e.g. Moderator console.send).
- [x] Users & roles API — privileged-role rules (Owner-only grants, last-owner protection, admins cannot manage privileged accounts).
- [x] Hash-chained audit log + API — advisory-locked single writer, redacted details, cursor pagination, `/audit/verify` with tamper detection; authz denials audited.
- [x] Secrets encryption service — AES-256-GCM, HKDF subkeys, AAD per row, key versions.
- [~] Web shell: layout, 15-section nav, theme (dark/light), global search, notifications, node-health indicator, quick actions, responsive — implemented (`apps/web/src/components/shell`); unit-tested: nav phase/permission gating, node-health summary, status mappings. Not yet exercised in a browser against a live control plane (responsive/keyboard behaviour unverified).
- [~] Web: login/setup/MFA flows, typed API client, realtime client — API client (CSRF, request ids, idempotency key, ApiError, 401/MFA/setup redirects, CSRF retry), realtime client (ref-counted topics, backoff+jitter, resubscribe, heartbeat, invalidate-on-reconnect) and route guards (incl. router-level redirect test) are tested; setup/login/MFA forms implemented but not run against the real auth API yet.
- [ ] CI workflow (lint, typecheck, test, build; Go vet/test)

## Phase 2 — Node agent & monitoring
- [x] Agent: config, CLI (`enroll`, `run`, `version`), keypair, enrollment — `services/node-agent`; agent.json/agent.key 0600, insecure-http loopback-only rule, CA pinning, `init-dirs` helper. Verified against an in-process fake control plane implementing agent-protocol §3/§3.1 (`internal/agent`); interop with the real control plane not yet exercised.
- [x] Agent: WSS transport, auth token, reconnect w/ backoff+jitter, command verification (sig/expiry/replay) — golden fixtures (all `cmd-*.json`, auth token, rotation proof) + durable `commands.journal` (restart replay test), staged credential rotation with fallback, priority outbox, approval gating. Verified against an in-process fake control plane implementing agent-protocol §3/§3.1 (`internal/agent`); interop with the real control plane not yet exercised.
- [x] Agent: heartbeat, facts (OS, kernel, CPU model/cores, RAM, disks, NICs, container runtime) — incl. Java runtimes from local `eclipse-temurin:*` images; verified in the containerised agent on Docker Desktop (compose test).
- [x] Agent: host metrics (CPU total/per-core/load/iowait, memory incl. cached/swap, fs usage+inodes, disk I/O + latency, net per iface + errors/drops, TCP conns) — host % clamped 0–100, veth/br-/docker0/lo excluded by default. A containerised agent reports only the data-root filesystem unless `HOST_ROOT` is mounted.
- [x] Agent: workload metrics from Docker stats (CPU, throttling, memory, net, blkio, pids) — docker-CLI CPU% (per core), usage − inactive_file, data-dir size every 5 min; verified on a real Paper server.
- [x] JVM probe (heap used/committed/max, GC, threads) + agent reader — `services/jvm-probe` (Java 8 bytecode, reproducible Docker build, sha256 recorded, embedded); run on Java 8/21/25; stale (>30 s) files ignored.
- [x] SLP ping (players, version, latency) — `internal/minecraft` (fake-server tests) + live Paper 1.21.8 via container IP (metrics) and published port (`node.probe`).
- [x] Control plane: enrollment tokens API, enroll endpoint, approval, revocation, key rotation — staged rotation job with proof-of-possession and pending-key promotion; tested end-to-end with `test/support/fake-agent.ts`. Interop with the real Go agent not yet exercised.
- [x] Control plane: agent gateway (sessions, command dispatch/await, timeouts, audit to `agent_commands`) — durable jti replay cache, one session per node, frame validation (malformed frames counted, session kept), field-level payload redaction, workload ownership checks, transfer rendezvous (streaming, node-bound, size/time limits).
- [x] Node connection state machine (online/degraded/unreachable/offline)
- [x] Metrics ingest → VictoriaMetrics; latest cache; range query API with whitelisted series — verified against the real VictoriaMetrics (null-filled step grid, scoped `global.*`).
- [x] Realtime gateway for UI (topics, authz, backpressure) — payloads validated against `REALTIME_EVENT_PAYLOADS` in tests; slow consumer → 4008.
- [~] Web: Overview dashboard (global metrics, allocated vs actual, charts w/ time ranges incl. custom, gaps for missing data) — implemented; tested: allocated-vs-used rendering, null → "Not configured/tracked yet"/"No data", empty-nodes CTA, chart null→gap transform, time ranges. uPlot rendering and `overview`/`metrics/range` integration unverified until the API runs.
- [~] Web: Nodes list/detail (facts, per-core CPU, memory, disks, IO, network, workloads) — list/detail/live tiles/history/settings/actions implemented; helpers tested (data-root filesystem, settings PATCH diff, tags, realtime payload parsing). Workloads per node wait for the servers API (Phase 3); not verified against a live agent.
- [~] Web: node enrollment UI — token dialog (secret + install command shown once, copy, explicit close) and token list/revoke implemented; token-state logic tested; not exercised against the enrollment API yet.
- [x] Basic alerts: node unreachable, CPU/memory/disk thresholds w/ duration, dedup/cooldown, ack/resolve — thresholds per `ALERT_RULE_KINDS` (disk = free % below), defaults seeded, job.failed alerts. `server.memory.high`/`server.heap.high`/`server.crashed` evaluation implemented but untested (needs Phase 3 servers/crash events).
- [~] Notification adapters: Discord webhook, email (SMTP), generic webhook (SSRF-safe) — channel CRUD (URL stored as secret, never returned), SSRF guard and delivery/retry recording tested with an injected transport; the pinned HTTPS transport has not been run against a real endpoint, and email (nodemailer) is untested (no SMTP server in the dev stack).

## Phase 3 — Server provisioning
- [x] `packages/minecraft`: catalogue adapters — Vanilla (piston-meta), Paper/Folia/Velocity (Fill API v3), Purpur, Fabric, Forge, NeoForge; Java mapping; checksums; restrictions — fixture tests + live smoke test (all 8 adapters, 2026-10-12); Forge/NeoForge/Fabric/Paper install+launch argv run in containers up to the EULA gate. Purpur publishes MD5 only and the Fabric launcher no checksum (contract change requested); Spigot deliberately unsupported (BuildTools only).
- [x] server.properties editor (preserve unknown keys/comments) + schema with descriptions/validation per version — byte-for-byte round-trip on files written by the real 26.3/1.21.8/1.20.3 jars; schema from 1.14→26.3 jars incl. the 1.21.9 move of pvp/allow-nether/enable-command-block to game rules (`packages/minecraft`).
- [ ] Placement scheduler (capacity, health, maintenance, tags/affinity, hard vs soft) + override audit
- [ ] Resource reservations
- [ ] Provision job (17 stages) idempotent, resumable, observable
- [x] Agent: workload.ensure/start/stop/kill/remove/status, hardened containers, restart policy, artifact.fetch w/ checksum + allowlist — Docker integration tests (hardening inspected on the engine, crash restart, limit, deliberate stop/kill, OOM, SIGTERM path, pull progress, re-attach, desired-state recovery, unmanaged-container safety) + Paper end-to-end through signed commands. Control-plane side (jobs/reconciler) not covered here.
- [ ] Lifecycle state machine + operation locks + reconciler from agent workload events
- [~] Readiness (log `Done (` + SLP) and crash detection — log parsers (readiness, crash/OOM/watchdog, Java class-version mismatch, port bind, EULA) done and tested in `packages/minecraft`; SLP + control-plane wiring pending.
- [~] Console: live stream, send commands, search/filter, colours, pause/follow, reconnect, download — agent side done and tested (rate-limited `logs` frames, ring buffer + Docker fallback for `workload.logs.tail`, persistent stdin attach for `workload.console`); UI/control plane pending.
- [ ] Server creation wizard (6 steps, simple/advanced)
- [ ] Server management page (overview, controls, state, metrics, alerts)
- [ ] Config editing w/ revisions, diff, rollback

## Phase 4 — Advanced server management
- [~] File manager (list/upload/download streaming/mkdir/rename/delete/edit/search/extract) w/ sandbox + redaction — agent side done and tested (`os.Root` sandbox, atomic `fs.write` + ifMatchSha256, extract with zip-slip/link/bomb defences, `fs.transfer.push/pull`); control plane/UI and redaction pending.
- [ ] Worlds (create/upload/import/replace/export, sizes, seeds) w/ safe shutdown
- [ ] Plugins/mods: Modrinth adapter, search/filter, install/update/remove/enable/disable, upload w/ policy, deps, history, rollback
- [ ] Players: online list, join/leave events, whitelist/ban/kick/op, history, lookup, counts over time
- [ ] Schedules: restarts/backups/updates/commands, cron + human readable, TZ, history, retries, concurrency, maintenance windows
- [ ] Server templates/profiles
- [ ] Software updates w/ rollback
- [~] Java runtime management (images per major, per-server selection, JVM args presets, incompatibility diagnostics) — library done and tested (`packages/minecraft`: Temurin JRE image per major, override validation, default/aikar/none presets, forbidden JVM flags, UnsupportedClassVersionError detection); UI/control plane pending.

## Phase 5 — Velocity & networks
- [x] `packages/velocity`: velocity.toml targeted editor, servers/try/forced-hosts generation, forwarding compatibility matrix, backend forwarding config writers — tested on the real Velocity 4.2.0 default config; plus redaction, network validator, plan/diff/rollout order, secret generation. YAML fixtures are representative (Paper writes its configs only after EULA acceptance).
- [ ] Network creation wizard (15 steps)
- [ ] Proxy provisioning (Velocity builds via Fill API)
- [ ] Backend registration (internal Docker network / private IP binding)
- [~] Modern forwarding with secure secret storage; unsafe combination warnings — secret generation/assessment, unsafe-combination validator and redaction done in `packages/velocity`; encrypted storage + API pending (control plane).
- [~] Forced hosts CRUD, duplicate detection, DNS/port guidance, preview, apply, rollback — normalisation (IDNA/RFC 1123/no wildcards), duplicate/conflict detection, DNS/SRV guidance and diff preview done in `packages/velocity`; CRUD/apply/rollback pending (control plane + UI).
- [ ] Topology editor (React Flow) backed by persisted drafts/plans; diff/apply/rollback
- [ ] Connectivity checks (proxy→backend probes, health)
- [ ] Network ops: rolling restart, maintenance mode, drain, cross-server player counts
- [ ] Real routing test with a headless client through Velocity (forced host → backend)

## Phase 6 — Backups & DR
- [ ] Backup jobs (world/full/config/extensions), consistency (save-off/save-all/flush or stop)
- [ ] Local + S3-compatible destinations, compression, retention, verification
- [ ] Restore with preview, integrity check, pre-restore recovery point, startup validation
- [ ] Coordinated network backups
- [ ] DR documentation with realistic RTO/RPO

## Phase 7 — Advanced operations
- [ ] Node drain/maintenance/disable scheduling/remove with workload handling
- [ ] Offline migration between nodes
- [ ] Staged updates & approvals
- [ ] Advanced alerts (heap exhaustion, IO latency, crash loops, proxy failures, backup capacity, agent outdated, config drift)
- [ ] Agent self-update (signed)
- [ ] Operational reporting

## Phase 8 — Security hardening
- [ ] STRIDE threat model, authz boundary review, secret review, dependency audit
- [~] Security test suite (traversal, zip-slip, injection, forged/replayed commands, secret leakage, cross-scope access) — agent side covered (traversal, symlink escape incl. symlinked parent, zip-slip, tar links/devices, zip/gzip bombs, FIFO, forged/expired/replayed/restart-replayed commands, root-path mutations, console line validation); control-plane parts pending.

## Phase 9 — Performance & production readiness
- [ ] Load tests (API latency, telemetry ingest, WS fan-out, log streaming, job throughput)
- [ ] Control-plane restart / agent disconnect / interrupted job recovery tests
- [ ] Multi-replica control plane (agent command routing via LISTEN/NOTIFY)
- [ ] Deployment automation, upgrade/rollback docs

## Phase 10 — Final acceptance
- [ ] E2E workflow 1–17 from spec §27
- [ ] Final docs set & known limitations

## Known limitations (kept honest)
- Per-server storage quotas are soft (monitored + enforced by stopping/refusing writes) unless the node's filesystem supports XFS project quotas.
- Tick performance (TPS/MSPT) requires Paper-family servers; reported via console sampling or a companion plugin (Phase 4).
- Live migration is not offered; migration is offline (stop → transfer → start → reroute).

## Current focus
Phase 1 foundation + Phase 2 agent, executed in parallel work areas (see `docs/development/workflow.md`).
