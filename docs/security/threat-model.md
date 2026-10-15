# Security Assumptions & Threat Model (Phase 0 baseline)

To be expanded into a full STRIDE review in Phase 8.

## Assets
Node hosts (root-equivalent if the agent is compromised), Minecraft world data, Velocity
forwarding secrets, user credentials/sessions, enrollment tokens, node private keys,
control-plane master key, backup archives, player personal data (names, UUIDs, IPs),
MySQL/MariaDB database-host admin credentials and per-server database passwords (Phase 5).

## Trust boundaries
1. Browser ↔ control plane (untrusted client; authenticated sessions).
2. Control plane ↔ node agent (mutually authenticated: agent → Ed25519 token; control plane
   → Ed25519-signed commands + TLS).
3. Agent ↔ workload container (container content is **untrusted**: plugins/mods execute
   arbitrary code inside the server process).
4. Control plane / agent ↔ the Internet (catalogue APIs, Modrinth, webhooks — SSRF surface).
4a. Control plane ↔ MySQL/MariaDB database hosts (admin account; hosts are trusted infrastructure chosen by
   administrators, the data inside per-server databases is untrusted).
5. Workload output → UI (log lines, file contents, MOTDs, player names are untrusted).

## Assumptions
* The control plane host and its database are trusted and operated by the platform owner.
* TLS terminates at the control plane or a trusted reverse proxy on the same host.
* The agent runs as a dedicated user in the `docker` group (or with rootless Docker). Docker
  group membership is root-equivalent; the agent therefore exposes **no** generic
  container or shell API — only the fixed command catalogue.
* Minecraft plugins/mods are arbitrary code. BlockForge contains them with container
  isolation and resource limits but cannot make a malicious plugin safe for the data inside
  that server. The UI states this when installing extensions.

## Key controls
| Threat | Control |
|--------|---------|
| Forged or replayed control-plane commands | Commands signed with the control-plane Ed25519 key pinned at enrollment; per-command `nodeId`, expiry, unique ID; fsync'd agent seen-set journal that survives restarts; idempotent command semantics. |
| Replayed agent tokens | Durable `agent_auth_jti` table shared by all control-plane replicas; 120 s max token lifetime. |
| Plain-HTTP downgrade | `--insecure-allow-http` only for loopback/`host.docker.internal`; any other http URL is refused. |
| Stolen enrollment token | Single-use, short expiry, hashed at rest, optional manual approval, audit event on use. |
| Stolen node key | Per-node revocation; staged key rotation with proof of possession and bounded overlap; heartbeat source IP recorded. |
| Moderator escalation via console | Raw console input (`servers.console.send`) is operator-equivalent and excluded from the Moderator role; moderators use structured player actions. |
| Wiping a data root | Mutation commands reject root-resolving paths in both the contract schema and the agent. |
| Command / shell injection | No shell anywhere: agent uses argv + Docker API; console lines validated (no CR/LF/NUL, ≤1024 chars); env keys allowlisted; images allowlisted. |
| Path traversal / symlink escape / zip-slip | Agent-side sandbox resolver; archive extraction rejects links/absolute/`..`, enforces size & entry limits. |
| SSRF | Catalogue/plugin downloads restricted to allowlisted HTTPS hosts on both control plane and agent; webhooks block private/link-local/loopback ranges unless an admin allowlists them; redirects re-validated. |
| XSS via logs/MOTD/player names | React escaping only (no `dangerouslySetInnerHTML`); ANSI/§ colour codes parsed into styled spans; strict CSP. |
| CSRF | `SameSite=Lax` session cookie + required `X-BlockForge-CSRF` header bound to session for non-GET. |
| Brute force | Rate limits per IP and per account; progressive lockout; argon2id. |
| Privilege escalation across servers | Every route resolves the target resource and checks scoped permissions (`server` → its `network` → its `node` → `global`). Tests cover cross-scope denial. |
| Secret leakage | Secrets encrypted at rest, never serialised in API responses/logs/audit details; pino redaction paths; file reads of known secret-bearing files (`paper-global.yml` proxies secret, `forwarding.secret`, FabricProxy-Lite config) redacted unless `secrets.read`. |
| Bypassing the proxy | Backends bind to internal Docker networks or a node private IP; `online-mode=false` backends are only allowed when modern forwarding (or an explicit, warned legacy mode) is configured; validator flags publicly bound offline-mode backends. |
| Resource exhaustion | Container memory/CPU/pids limits; storage quota monitoring with hard stop option; log rate limits; bounded queues and WebSocket buffers; upload size limits. |
| Audit tampering | Insert-only hash-chained `audit_events`; verification endpoint. |
| SQL injection against database hosts (Phase 5) | The control plane runs DDL/DCL on MySQL/MariaDB hosts. These statements accept no `?` parameters, so only allowlisted values reach them: database names `s<shortId>_[a-z0-9_]{1,48}`, generated usernames and passwords, host patterns normalised to `[a-z0-9.%:/-]`; each is re-checked right before it is backtick-/single-quoted (`databases/sql.ts`), and the table CHECK constraints repeat the allowlists. Unit tests feed injection strings to every builder. |
| Over-broad database grants | `GRANT` of Pterodactyl's 18 database-level privileges on the server's own database only (no GRANT OPTION, nothing global). `_` in the database name is escaped in the GRANT (`\_`) because it is a wildcard in database-level grants (unescaped, a grant on `s…_a_b` would also cover — and let the user CREATE — `s…_aXb`); MySQL with `partial_revokes = ON` reads grant names literally, so the escape is omitted there. Integration tests on MariaDB 11.4 and MySQL 8.4 connect as the created user and prove it cannot read another database, create databases or users, or grant. |
| Database credential leakage | Host admin passwords and per-database passwords are AES-256-GCM encrypted (`SecretBox`, row-bound AAD); the admin password is write-only; database passwords only come from `GET …/password` (`servers.databases.view_password`, separate from `.view`, audited, `Cache-Control: no-store`, rate-limited). Host errors are mapped to fixed messages (mysql2 errors carry the SQL text incl. `IDENTIFIED BY '…'` in `err.sql`, and MySQL messages may quote it), the few free-text parts (TLS errors) are scrubbed of every known secret however short, and the log serializer drops mysql2 statements. A rotation whose `ALTER USER` reached the host but whose outcome could not be recorded leaves a stale stored password (never a leaked one); rotating again repairs it. Tests scan responses, audit, jobs, job logs, events and debug logs for every password. |
| Stored admin password sent elsewhere (rogue admin / SSRF via host edit) | Changing `host`, `port`, `username`, `tlsMode` or the pinned CA requires re-entering the password (also for test connections with a saved host), so a stored password is never presented to a new endpoint or over a weaker channel. `mysql_clear_password` is refused, LOCAL INFILE is disabled. Connecting to an admin-chosen address is otherwise inherent (admin-only `database_hosts.manage`; failures report only fixed messages, which limits port-scan detail). |
| Impersonated database host (active MITM between control plane and host) | Only `tlsMode: verify_ca` authenticates the host (chain verified against the pinned CA; host name not checked). `preferred` and `required` encrypt but accept any certificate, so an active attacker on that path can impersonate the host and obtain the admin credentials (caching_sha2/sha256 send the password inside TLS); the API docs and UI label them "host not verified", and the CA is accepted only with `verify_ca` (CHECK constraint). Use `verify_ca` whenever the network between control plane and host is not trusted, pinning a private CA or the server's own certificate — never a public CA, since the host name is not checked (documented in the API docs and the UI). |
| KILL hitting an unrelated connection behind a proxy / load balancer | The greeting connection id is not the server thread behind MaxScale/ProxySQL, and a load balancer may route the KILL connection to another server where the same id names a customer connection. Sessions record `CONNECTION_ID()` and the server identity (`@@server_id`, `@@hostname`, `@@port`, version, `@@server_uuid` on MySQL); `KILL` is sent and a statement counted stopped only when both the original and the fresh connection prove to be direct connections (greeting id = `CONNECTION_ID()`) to the same server. Otherwise nothing is killed and the outcome is unknown (reconciled through `password_unknown` / `cleanup_pending`). Test connection reports `proxyDetected`; tested with a proxy that rewrites the greeting id (no KILL sent, `unknownOutcome`). |
| Shutdown or maintenance held by a frozen database host | Shutdown first refuses new host connections, cancels the sweep and abandons running statements without KILL round trips (outcomes recorded as unknown, deletion jobs retried after the restart); the sweep handles each host in one session, skips a host after its first failure, and caps rows per host and hosts in parallel. Tested: shutdown during a sweep stuck on a frozen host returns in about a second with a 60 s statement timeout (without the fix the test times out). |
| Statements that land after they "failed" (host stuck behind FLUSH TABLES WITH READ LOCK, metadata locks, lost answers) | Admin sessions set `lock_wait_timeout` (+ `max_statement_time` on MariaDB) below the client timeout so the host aborts stuck statements itself; an unanswered statement is `KILL QUERY`-ed from a fresh connection and confirmed gone in the process list, its session discarded (no later statement queues behind it), and the outcome decided by inspecting the host. Undecidable outcomes are recorded (`password_unknown`, `cleanup_pending`) and reconciled (rotate again; sweep drops by name after the late-landing window). Creation verifies both names are free on the host before creating anything, so clean-up by name never touches pre-existing objects. Tested on MariaDB with FTWRL, metadata locks, a proxy that swallows or delays answers, job cancellation and the step deadline. |
| Control-plane degradation through slow database hosts | No Postgres transaction, row lock or pooled connection is held while a host is contacted (claim → host I/O → conditional persist; integration test with a host that accepts and never answers: 12 concurrent rotations with a 10-connection pool, no idle-in-transaction session, no lock, other requests served at once). Host operations are bounded by the connect (10 s) and statement (15 s) timeouts and rate-limited per IP. |
