# BlockForge — Architecture Overview

Status: Phase 0 baseline (2026-10-11). Living document; update with every architectural change.

## 1. Repository assessment

`P:\BlockForge` was empty at project start (no code, no VCS, no instructions files). This is a
greenfield project. Toolchain available on the primary dev machine (Windows 11, 32 logical
cores, 64 GB RAM):

| Tool | Version | Notes |
|------|---------|-------|
| Node.js | 24.13 | control plane + web |
| pnpm | 10.32 | workspace manager |
| Go | 1.27.2 | installed portable at `C:\Users\lmari\sdk\go` for the node agent |
| Docker Desktop | 29.8 (Linux engine, cgroup v2) | Postgres, VictoriaMetrics, Minecraft workloads in dev |
| git / gh | 2.55 / 2.93 | |

No Postgres/Redis on the host — they run in Docker (`infra/compose`).

## 2. System shape

```
 Browser (React SPA)
   │  HTTPS: REST /api/v1/*  +  WSS /api/v1/realtime  (session cookie + CSRF header)
   ▼
 Control plane (apps/control-plane, Node.js/Fastify, single process in v1)
   ├─ HTTP API, auth, RBAC, audit
   ├─ Agent gateway  ◄── WSS /agent/v1/connect (outbound from each node; Ed25519 auth)
   ├─ Job runner (pg-boss) + scheduler + reconciler + alert evaluator
   ├─ Metrics ingest ──► VictoriaMetrics (time series, retention-bounded)
   └─ PostgreSQL (durable relational state, job queue, audit log)
   ▲
   │  WSS (agent-initiated, NAT-friendly) + HTTPS transfer endpoints
 Node agent (services/node-agent, Go static binary) — one per machine
   ├─ Host telemetry (CPU/mem/disk/net/IO), workload telemetry, JVM probe, SLP ping
   ├─ Docker workload driver (one container per Minecraft server / Velocity proxy)
   ├─ Sandboxed file operations under <dataRoot>/servers/<id>/data
   └─ Log streaming, console stdin, artifact download + checksum verification, backups
```

Key principle: **the web app never touches a Minecraft process.** The browser talks only to
the control plane. The control plane never runs shell commands; it sends *signed, typed,
schema-validated commands* to agents. Agents execute a fixed catalogue of operations with
tightly scoped arguments and never spawn a shell.

## 3. Technology decisions (ADR summary)

Rationale is summarised here; a dedicated ADR file is added under `docs/architecture/adr/` whenever a decision is revisited or superseded.

| # | Decision | Why |
|---|----------|-----|
| ADR-001 | pnpm workspaces + Turborepo monorepo for TS; Go module for the agent in `services/node-agent` | Shared contracts between web and control plane; independent Go build/release. |
| ADR-002 | Control plane: Node 24 + TypeScript + Fastify 5 | Fast, schema-first, first-class WebSocket support, same language as the web app → shared zod contracts. |
| ADR-003 | PostgreSQL 17 + Drizzle ORM + drizzle-kit migrations | Typed SQL, checked-in SQL migrations, no heavyweight runtime. |
| ADR-004 | pg-boss for durable jobs and cron instead of Redis/BullMQ | Durable queue in the database we already operate; transactional enqueue; one less service. Redis stays optional (not used in v1). |
| ADR-005 | VictoriaMetrics single-node for time series | Push-based import (agents sit behind NAT, so Prometheus scraping is awkward), PromQL queries, built-in retention, tiny footprint. The app DB never stores high-volume samples. |
| ADR-006 | Node agent in Go, Docker Engine API as the first workload runtime | Static binary, low overhead, mature `gopsutil` + Docker SDK. Rootless Docker and Podman (Docker-compatible API socket) are supported through the same driver. |
| ADR-007 | Agent identity = Ed25519 keypair generated on the node during enrollment; control-plane commands are Ed25519-signed with expiry + unique IDs | No shared secrets in source; replay protection; revocable per node. See `agent-protocol.md`. |
| ADR-008 | Local auth: argon2id passwords, opaque server-side sessions, TOTP MFA, CSRF header; OIDC adapter later | Self-hosted product must work offline; backend never trusts frontend auth state. |
| ADR-009 | Config files are edited by the control plane (TS libraries in `packages/minecraft`, `packages/velocity`) and written by the agent atomically with optimistic `ifMatchSha256` | Keeps all format knowledge in one place, preserves unrelated settings, gives revision history + rollback. |
| ADR-010 | Web: React 19 + Vite + Tailwind v4 + Radix-based shadcn-style components + TanStack Router/Query + uPlot + React Flow | Typed routing, cache-first server state, uPlot handles high-frequency series cheaply; React Flow for the topology editor. |
| ADR-011 | Minecraft workloads run in hardened containers (non-root UID, `no-new-privileges`, all caps dropped, memory/CPU/pids limits, no Docker socket) using Eclipse Temurin JRE images selected by required Java major version | Isolation, reproducibility; Java version comes from Mojang's authoritative per-version metadata. |
| ADR-012 | Logs: agent streams stdout of every managed workload (rate-limited) to the control plane; control plane keeps a bounded ring buffer per server and parses lifecycle/player events; history comes from on-disk log files | One pipeline drives console, readiness detection, crash detection and player events. |
| ADR-013 | Per-server MySQL/MariaDB databases (Phase 5) are created by the control plane itself over `mysql2` (one short-lived admin connection per operation, no pool), not by agents | Database hosts are shared infrastructure reachable from the control plane; keeps agents free of database credentials. Statements take no parameters, so values are allowlist-validated and quoted at the point of use (`databases/sql.ts`). |

## 4. Module boundaries

| Path | Responsibility | Owner agent |
|------|----------------|-------------|
| `packages/contracts` | Domain types, zod schemas, REST DTOs, realtime topics, agent protocol schemas, events, permissions, lifecycle state machine. **Single source of truth for shared interfaces.** | Architecture |
| `packages/minecraft` | Server software catalogue adapters (Mojang, Paper/Folia/Velocity via Fill API, Purpur, Fabric, Forge, NeoForge), Java version mapping, `server.properties` editor, JVM flag presets, SLP/log parsers. Pure, no I/O except injected fetch. | Minecraft |
| `packages/velocity` | `velocity.toml` targeted editor, forced-host validation, forwarding-mode compatibility matrix, backend forwarding config generation (paper-global.yml, FabricProxy-Lite, etc.), network plan/diff. Pure. | Minecraft |
| `apps/control-plane` | REST API, realtime gateway, agent gateway, jobs, scheduler, reconciler, alerting, metrics ingest/query, persistence. | Backend + Monitoring + Security |
| `apps/web` | SPA control panel. | Frontend |
| `services/node-agent` | Go agent. | Infrastructure |
| `services/jvm-probe` | Tiny Java agent (`-javaagent`) exporting heap/GC/thread stats to a file the node agent reads. | Infrastructure |
| `infra/compose` | Docker Compose for dev and single-host installs. | Infrastructure |
| `tests/e2e` | Playwright + real-agent end-to-end tests. | Testing |

`apps/worker` is intentionally **not** created in v1: jobs run inside the control-plane
process because they dispatch commands over agent WebSocket sessions held by that process.
Horizontal scale-out (multiple control-plane replicas) requires routing agent commands
between replicas via Postgres `LISTEN/NOTIFY`; the `AgentGateway` interface is the seam for
that (tracked in `docs/CHECKLIST.md`, Phase 9).

## 5. Data flow examples

**Provision a Paper server**
1. `POST /api/v1/servers` → validates DTO + RBAC → placement (`scheduler/placement.ts`) →
   reserves resources (`resource_reservations`) → inserts `servers` row (state
   `provisioning`) + `jobs` row → enqueues `server.provision` in the same transaction.
2. Job worker: resolves build from catalogue (checksummed URL) → `workload.ensure` →
   `artifact.fetch` (agent verifies SHA-256) → control plane renders `server.properties`,
   `eula.txt`, forwarding config → `fs.write` (atomic) → `workload.start` → waits for log
   line `Done (` + SLP ping → marks `running`, releases reservation hold → emits
   `server.provision.completed`. Each step is idempotent and recorded in `job_steps`.
3. UI follows `job:<id>` realtime topic; on reconnect it re-reads `GET /api/v1/jobs/:id`.

**Telemetry**
Agent samples every 5 s, sends a batch every 10 s → control plane validates, updates the
in-memory "latest" cache, pushes `metrics` frames to subscribed UI clients, and writes to
VictoriaMetrics. Charts query `GET /api/v1/metrics/range` which maps a whitelisted series
id to a PromQL template (no user-supplied PromQL).

## 6. Deployment models

* **Single host**: `infra/compose/docker-compose.yml` runs Postgres, VictoriaMetrics, the
  control plane (serving the built SPA) and, optionally, a node agent on the same machine.
* **Multi-node**: control plane + DB + VM on a management host behind a TLS reverse proxy;
  the agent binary installed as a systemd service on every Minecraft node, enrolled with an
  expiring token. Off-node backups to S3-compatible storage.

See `docs/operations/` for install guides (written in Phase 1/9).
