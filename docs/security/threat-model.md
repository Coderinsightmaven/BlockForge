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
| Database credential leakage | Host admin passwords and per-database passwords are AES-256-GCM encrypted (`SecretBox`, row-bound AAD); the admin password is write-only; database passwords only come from `GET …/password` (`servers.databases.view_password`, separate from `.view`, audited, `Cache-Control: no-store`, rate-limited). Host errors are mapped to fixed messages (mysql2 errors carry the SQL text incl. `IDENTIFIED BY '…'` in `err.sql`, and MySQL messages may quote it) and the log serializer drops mysql2 statements. Tests scan responses, audit, jobs, job logs, events and debug logs for every password. |
| Stored admin password sent elsewhere (rogue admin / SSRF via host edit) | Changing `host`, `port`, `username`, `tlsMode` or the pinned CA requires re-entering the password (also for test connections with a saved host), so a stored password is never presented to a new endpoint or over a weaker channel. `mysql_clear_password` is refused, LOCAL INFILE is disabled. Connecting to an admin-chosen address is otherwise inherent (admin-only `database_hosts.manage`; failures report only fixed messages, which limits port-scan detail). TLS `preferred`/`required` without a CA do not authenticate the host (documented); pin a CA for verification. |
