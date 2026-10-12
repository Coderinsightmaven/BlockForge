# Security Assumptions & Threat Model (Phase 0 baseline)

To be expanded into a full STRIDE review in Phase 8.

## Assets
Node hosts (root-equivalent if the agent is compromised), Minecraft world data, Velocity
forwarding secrets, user credentials/sessions, enrollment tokens, node private keys,
control-plane master key, backup archives, player personal data (names, UUIDs, IPs).

## Trust boundaries
1. Browser ↔ control plane (untrusted client; authenticated sessions).
2. Control plane ↔ node agent (mutually authenticated: agent → Ed25519 token; control plane
   → Ed25519-signed commands + TLS).
3. Agent ↔ workload container (container content is **untrusted**: plugins/mods execute
   arbitrary code inside the server process).
4. Control plane / agent ↔ the Internet (catalogue APIs, Modrinth, webhooks — SSRF surface).
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
