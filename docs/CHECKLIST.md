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
- [ ] Control plane skeleton: config, pino logging w/ redaction, request IDs, error format, health endpoints, graceful shutdown
- [ ] Drizzle schema + migrations (identity, nodes, servers, networks, jobs, audit, secrets, events)
- [ ] First-run owner setup (one-time setup token)
- [ ] Auth: argon2id login/logout, sessions, CSRF, rate limits, lockout
- [ ] TOTP MFA enrol/verify/disable
- [ ] RBAC: built-in roles, scoped bindings, `authorize()` + tests
- [ ] Users & roles API
- [ ] Hash-chained audit log + API
- [ ] Secrets encryption service
- [ ] Web shell: layout, 15-section nav, theme (dark/light), global search, notifications, node-health indicator, quick actions, responsive
- [ ] Web: login/setup/MFA flows, typed API client, realtime client
- [ ] CI workflow (lint, typecheck, test, build; Go vet/test)

## Phase 2 — Node agent & monitoring
- [ ] Agent: config, CLI (`enroll`, `run`, `version`), keypair, enrollment
- [ ] Agent: WSS transport, auth token, reconnect w/ backoff+jitter, command verification (sig/expiry/replay)
- [ ] Agent: heartbeat, facts (OS, kernel, CPU model/cores, RAM, disks, NICs, container runtime)
- [ ] Agent: host metrics (CPU total/per-core/load/iowait, memory incl. cached/swap, fs usage+inodes, disk I/O + latency, net per iface + errors/drops, TCP conns)
- [ ] Agent: workload metrics from Docker stats (CPU, throttling, memory, net, blkio, pids)
- [ ] JVM probe (heap used/committed/max, GC, threads) + agent reader
- [ ] SLP ping (players, version, latency)
- [ ] Control plane: enrollment tokens API, enroll endpoint, approval, revocation, key rotation
- [ ] Control plane: agent gateway (sessions, command dispatch/await, timeouts, audit to `agent_commands`)
- [ ] Node connection state machine (online/degraded/unreachable/offline)
- [ ] Metrics ingest → VictoriaMetrics; latest cache; range query API with whitelisted series
- [ ] Realtime gateway for UI (topics, authz, backpressure)
- [ ] Web: Overview dashboard (global metrics, allocated vs actual, charts w/ time ranges incl. custom, gaps for missing data)
- [ ] Web: Nodes list/detail (facts, per-core CPU, memory, disks, IO, network, workloads)
- [ ] Web: node enrollment UI
- [ ] Basic alerts: node unreachable, CPU/memory/disk thresholds w/ duration, dedup/cooldown, ack/resolve
- [ ] Notification adapters: Discord webhook, email (SMTP), generic webhook (SSRF-safe)

## Phase 3 — Server provisioning
- [ ] `packages/minecraft`: catalogue adapters — Vanilla (piston-meta), Paper/Folia/Velocity (Fill API v3), Purpur, Fabric, Forge, NeoForge; Java mapping; checksums; restrictions
- [ ] server.properties editor (preserve unknown keys/comments) + schema with descriptions/validation per version
- [ ] Placement scheduler (capacity, health, maintenance, tags/affinity, hard vs soft) + override audit
- [ ] Resource reservations
- [ ] Provision job (17 stages) idempotent, resumable, observable
- [ ] Agent: workload.ensure/start/stop/kill/remove/status, hardened containers, restart policy, artifact.fetch w/ checksum + allowlist
- [ ] Lifecycle state machine + operation locks + reconciler from agent workload events
- [ ] Readiness (log `Done (` + SLP) and crash detection
- [ ] Console: live stream, send commands, search/filter, colours, pause/follow, reconnect, download
- [ ] Server creation wizard (6 steps, simple/advanced)
- [ ] Server management page (overview, controls, state, metrics, alerts)
- [ ] Config editing w/ revisions, diff, rollback

## Phase 4 — Advanced server management
- [ ] File manager (list/upload/download streaming/mkdir/rename/delete/edit/search/extract) w/ sandbox + redaction
- [ ] Worlds (create/upload/import/replace/export, sizes, seeds) w/ safe shutdown
- [ ] Plugins/mods: Modrinth adapter, search/filter, install/update/remove/enable/disable, upload w/ policy, deps, history, rollback
- [ ] Players: online list, join/leave events, whitelist/ban/kick/op, history, lookup, counts over time
- [ ] Schedules: restarts/backups/updates/commands, cron + human readable, TZ, history, retries, concurrency, maintenance windows
- [ ] Server templates/profiles
- [ ] Software updates w/ rollback
- [ ] Java runtime management (images per major, per-server selection, JVM args presets, incompatibility diagnostics)

## Phase 5 — Velocity & networks
- [ ] `packages/velocity`: velocity.toml targeted editor, servers/try/forced-hosts generation, forwarding compatibility matrix, backend forwarding config writers
- [ ] Network creation wizard (15 steps)
- [ ] Proxy provisioning (Velocity builds via Fill API)
- [ ] Backend registration (internal Docker network / private IP binding)
- [ ] Modern forwarding with secure secret storage; unsafe combination warnings
- [ ] Forced hosts CRUD, duplicate detection, DNS/port guidance, preview, apply, rollback
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
- [ ] Security test suite (traversal, zip-slip, injection, forged/replayed commands, secret leakage, cross-scope access)

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
