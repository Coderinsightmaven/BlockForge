# @blockforge/control-plane

Fastify 5 control plane: REST API (`/api/v1`), UI realtime gateway, agent gateway
(`/agent/v1`), durable jobs, metrics ingest/query, alerting and notifications. Single process
in v1 (see `docs/architecture/overview.md`).

## Running

```sh
pnpm infra:up                                   # Postgres :55432 + VictoriaMetrics :58428
pnpm --filter @blockforge/control-plane dev     # tsx watch; listens on 127.0.0.1:8080
curl http://127.0.0.1:8080/readyz
```

Migrations run automatically at start-up (under a Postgres advisory lock). On first start the
log prints a one-time **setup token** (`POST /api/v1/auth/setup`); a new one is printed on every
restart until an owner exists.

> Trade-off (review #17): the setup token is written into the log *message* so an operator can
> read it from `docker logs`/journald; the structured `setupToken` field is redacted. Anyone who can
> read the control-plane log before setup completes can claim the installation, so restrict log
> access during first boot. The token is single-use, replaced on every restart and stored only as
> a hash.

| Script | |
|---|---|
| `dev` | `tsx watch` on `src/main.ts` (workspace packages resolve to their TS sources) |
| `build` / `start` | `tsc -p tsconfig.build.json` → `dist/`; `node dist/main.js` (needs `@blockforge/contracts` built) |
| `typecheck` / `lint` | `tsc --noEmit` over src+test; root ESLint config |
| `test` | vitest: unit + integration (real Postgres `blockforge_test` and VictoriaMetrics) |
| `db:generate` | drizzle-kit generate (run with the `@blockforge/source` condition) after schema changes (keep the `CREATE EXTENSION citext` line at the top of `0000_init.sql`) |
| `db:migrate` | apply migrations without starting the server |

### Configuration (environment, validated with zod in `src/config/env.ts`)

| Variable | Default | Notes |
|---|---|---|
| `DATABASE_URL` | dev compose URL | required in production |
| `VICTORIA_METRICS_URL` | `http://127.0.0.1:58428` | required in production |
| `PUBLIC_URL` | `http://127.0.0.1:5173` | browser origin; realtime + mutation `Origin` checks, CSP, cookie `Secure` default |
| `AGENT_URL` | `PUBLIC_URL` | URL put into agent install commands |
| `LISTEN_HOST` / `LISTEN_PORT` | `127.0.0.1` / `8080` | |
| `DATA_DIR` | `.data` | dev master key file lives here |
| `BLOCKFORGE_MASTER_KEY` | — | base64, 32 bytes. Dev: auto-generated to `DATA_DIR/master.key` (0600) with a loud warning. **Production refuses to start without it.** Back it up: every secret and the command-signing key are encrypted with it. |
| `COOKIE_SECURE` | `true` iff `PUBLIC_URL` is https | |
| `TRUST_PROXY` | `false` | `true`, hop count, or comma list of proxy addresses |
| `LOG_LEVEL` | `info` | |
| `SMTP_HOST`, `SMTP_PORT`, `SMTP_SECURE`, `SMTP_USER`, `SMTP_PASSWORD`, `SMTP_FROM` | — | email notifications (channel creation is refused without SMTP) |
| `WEB_DIST_DIR` | — | serve the built SPA from the same origin (SPA fallback for non-API GETs) |
| `PGBOSS_SCHEMA` | `pgboss` | |
| `AGENT_HEARTBEAT_INTERVAL_MS` / `AGENT_METRICS_INTERVAL_MS` | 15000 / 5000 | sent to agents in `welcome` |
| `NODE_OFFLINE_AFTER_MS`, `NODE_SWEEP_INTERVAL_MS`, `ALERT_EVAL_INTERVAL_MS`, `METRICS_FLUSH_INTERVAL_MS` | 5 min, 5 s, 20 s, 1 s | |

## Module layout (`src/`)

| Module | Responsibility |
|---|---|
| `app.ts`, `main.ts`, `context.ts` | `buildApp(deps)` factory (used by tests), process entry with graceful shutdown, service container |
| `config/` | env schema, master key loading |
| `logging/` | pino with redaction paths and a SQL-parameter-free error serializer |
| `db/` | Drizzle schema (`schema/*.ts`, every table in data-model.md except the Phase 4/6 backup/schedule tables), pool, advisory-locked migrator, `withTransaction` + after-commit hooks |
| `http/` | auth hooks (session → CSRF/Origin → MFA gate → principal), `ApiError` handling, request ids, health, idempotency keys |
| `auth/` | argon2id passwords, opaque sessions (sha256 at rest), session-bound CSRF, login throttling + progressive lockout, TOTP, setup token |
| `rbac/` | pure `authorize()` / scope resolution (server → node and network → global) and DB loading, built-in role reconciliation |
| `users/`, `audit/`, `secrets/`, `settings/` | user/role admin with privileged-role rules; hash-chained audit log; AES-256-GCM secret box + `secrets` table; validated settings |
| `events/` | domain event bus with `events` outbox (at-least-once, re-dispatch sweep) |
| `jobs/` | pg-boss backed `JobRunner` (persisted, resumable steps, retries with backoff, cancellation, bounded logs, restart recovery) + `node.credentials.rotate` |
| `agents/` | enrollment, `BFAgent` token verification (durable jti), staged key rotation, WebSocket sessions + signed command dispatch, frame validation, node connection state machine, console ring buffers, transfer rendezvous |
| `nodes/` | Node DTOs (capacity, reservations, live sample), node admin routes |
| `metrics/` | Prometheus text encoding, buffered VictoriaMetrics writer, latest cache, whitelisted PromQL templates, range queries |
| `overview/` | scoped fleet summary + throttled realtime publisher |
| `realtime/` | topic hub, per-topic authorisation, UI WebSocket gateway (Origin, 1 MiB buffer → 4008) |
| `alerts/`, `notifications/` | rules/incidents, evaluator (duration, dedup, cooldown, auto-resolve), channels, Discord/webhook/email adapters, SSRF guard |
| `templates/`, `catalog/` | built-in Minecraft/Velocity templates + egg import/edit/export (`@blockforge/eggs`); software catalogue (`@blockforge/minecraft` adapters) behind an HTTPS-only, host-allowlisted, DNS-checked fetch with a TTL cache |
| `allocations/`, `scheduler/` | node port pools and server allocations; placement candidates (hard/soft constraints, scores) under a per-node advisory lock |
| `servers/` | effective permissions (roles ∪ owner ∪ subuser), DTOs, create/settings/build/suspend/startup/subusers/console, operation locks + state transitions, provision/reinstall/power/delete jobs (Minecraft + eggs), reconciler from agent events |
| `files/` | file manager over `fs.*` (template denylist, proxy-secret redaction, archive jobs), single-use session-bound browser transfer URLs streamed through the agent rendezvous |
| `account/`, `sftp/` | SSH keys; `POST /agent/v1/sftp/auth` (username `<user>.<shortId>`, keys-only for MFA users, rate limits, audit) and `sftp.activity` → server activity |

## Security notes

* **Agent command signing key**: Ed25519, generated on first boot and stored *in the database*
  (`secrets`, AES-256-GCM with the master key) rather than as a file in `DATA_DIR`, so it survives
  host rebuilds with the DB backup and can be shared by future replicas. Losing the master key
  means re-enrolling every node.
* **Agent tokens**: signature over the claims segment for the node's active (or unexpired pending)
  key, lifetime ≤ 120 s, ±30 s skew, `jti` inserted into `agent_auth_jti` (replay = conflict) only
  after the signature verified. Revoked/disabled nodes are rejected.
* **CSRF**: `x-blockforge-csrf` must match the sha256 stored on the session (constant-time);
  `/auth/login` and `/auth/setup` instead require `Content-Type: application/json`; any mutation
  carrying a foreign `Origin` is rejected.
* **Transfer URLs** (`/api/v1/transfers/:token`): 256-bit, single use, bound to the issuing session,
  5 minutes, in memory (a restart invalidates outstanding URLs); the token replaces the CSRF header
  there (a foreign `Origin` is still rejected). Access (file permission, suspension, denylist) is
  re-checked when the URL is used.
* **File manager**: the template denylist (non-admins) and the proxy-secret files (users without
  `secrets.read`) are sent with every `fs.*` command; the agent enforces them on requested *and*
  symlink-resolved paths (and archive/copy entries), so links cannot alias protected files.
* **Console**: values of non-user-viewable egg variables (and their base64) are masked in install
  and console output before the ring buffer, realtime and job logs see it.
* **Catalogue fetch**: HTTPS to allowlisted hosts only; every hop's DNS answer must be public and the
  connection is pinned to that validated address (no rebinding window); bounded size and redirects.
* **Webhooks**: HTTPS only, every resolved address must be public (IPv4/IPv6 incl. mapped/NAT64/
  6to4 forms, metadata ranges) unless the host is in `notifications.webhookAllowlist`; the socket is
  pinned to the validated address; redirects are **not followed**; 10 s timeout; 64 KiB response cap.
  Discord channels only accept `discord.com`/`discordapp.com` webhook URLs and disable mentions.

## Tests

`pnpm --filter @blockforge/control-plane test` — needs the dev compose stack. The global setup
drops and recreates the `blockforge_test` schemas and applies the migrations; suites truncate all
tables per test and run sequentially. `test/support/fake-agent.ts` is a scriptable agent (real
Ed25519 keys, `BFAgent` tokens, signature verification of every command using the reference
checks from the contracts fixtures, staged key rotation, transfer uploads/downloads).
