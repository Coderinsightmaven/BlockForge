# BlockForge as a Pterodactyl replacement

Decision (2026-10-12, product owner): BlockForge is positioned as a **fast, modern replacement for
Pterodactyl** — Minecraft-first, with generic game support through imported Pterodactyl/Pelican
**eggs**. No migration tooling from an existing panel (egg JSON import only). Panel parity comes
before Velocity network management.

## Concept mapping

| Pterodactyl | BlockForge | Notes |
|-------------|------------|-------|
| Panel (PHP/Laravel) | Control plane (Fastify) + SPA (React) | One process + static SPA; Postgres + VictoriaMetrics. |
| Wings (Go daemon) | Node agent (Go) | Outbound WebSocket (NAT-friendly; no inbound port except SFTP), Ed25519-signed commands, replay journal. |
| Locations | `nodes.location` + tags | Placement can prefer tags/location. |
| Nests | Template `category` | |
| Eggs | Templates (`kind: egg`) | Import PTDL_v1/PTDL_v2/PLCN_v1 JSON. Built-in `minecraft` / `velocity` templates are catalogue-driven (version + build picker with checksums). |
| Egg variables + rules | `TemplateVariable` + Laravel-rule subset | Unsupported rules are reported at import, never silently ignored. |
| Install scripts | `workload.install` one-shot container | Root inside the container with a minimal capability set; data chowned back to the workload UID. |
| Yolks images | Allowed via agent image allowlist (`repo:*` entries) | Defaults include `ghcr.io/pterodactyl/yolks`, `ghcr.io/pterodactyl/installers`, `ghcr.io/parkervcp/yolks`, `ghcr.io/parkervcp/installers`, `eclipse-temurin`. |
| Allocations | `allocations` per node | Primary + additional (limit); TCP+UDP published; port-in-use warnings from the agent. |
| Server owner / subusers | `servers.owner_id` + `server_subusers` | Granular server-scoped permissions; granters cannot grant what they don't hold. |
| Client permissions (`control.*`, `file.*`, …) | `servers.*` server-scoped permissions | See `SERVER_OWNER_PERMISSIONS`. |
| Startup / docker image switch | `/servers/:id/startup` | User-editable variables, image choice among template images. |
| File manager | `/servers/:id/files/*` + streaming transfers | Editor, upload/download (streamed), archive/extract, chmod, search, denylist. |
| SFTP (Wings :2022) | Agent SFTP server (:2022) | Auth via control plane; SSH keys; password auth refused when the user has MFA. |
| Schedules | Schedules (Phase 4) | Cron + sequential tasks (command / power / backup), offsets, only-when-online. |
| Backups (local / S3) | Backups (Phase 4) | Consistent (save-off/save-all for Minecraft), locked backups, limits, restore. |
| Databases (MySQL hosts) | Database hosts (admin) + per-server databases (Phase 5) | Same naming (`s<shortId>_<name>`, `u<shortId>_<random>`), privileges, limits (`databaseLimit`) and permissions (`servers.databases.view/create/update/delete/view_password`); plus TLS modes with optional CA pinning, escaped grant wildcards, CIDR "connections from", per-host `maxDatabases`, password re-entry when connection settings change. No per-database `max_connections` yet. |
| Client + Application API keys | API keys scoped to a user's permissions (Phase 4) | One API, permission-scoped (no separate "application" API). |
| Activity log | Hash-chained audit log, per-server view | Includes SFTP mutations reported by the agent. |
| Mounts | Not planned for v1 | Host path mounts weaken isolation; revisit with an allowlist design. |
| Server transfer between nodes | Offline migration (Phase 7) | |

## Where BlockForge is intentionally better
* **Real monitoring**: host + per-server CPU/memory/disk/network history (VictoriaMetrics), JVM heap/GC,
  Minecraft player counts via SLP — not just live stats.
* **Security**: no inbound daemon API; signed + replay-protected commands; hardened non-root containers
  with read-only root fs; sandboxed file ops (`os.Root`); hash-chained audit log; MFA-aware SFTP.
* **Minecraft depth**: authoritative version/build catalogue with checksums and Java mapping, properties
  editor with per-version schema, Velocity networks and forced hosts (Phase 6).
* **Speed** (budgets below), content-addressed artifact cache per node, live everything over one socket.

## Performance budgets ("fast")
Measured on the dev box + test node (LAN). Regressions against these are bugs.

| Area | Budget |
|------|--------|
| SPA initial load (cold, gzip) | ≤ 300 KB JS for the shell route; LCP ≤ 1.5 s on LAN |
| Route change | ≤ 100 ms to first meaningful paint (data from cache or skeleton) |
| REST reads (p95, 100 servers / 10 nodes) | ≤ 50 ms |
| Power action → agent acknowledges | ≤ 300 ms p95 |
| Console line agent → browser | ≤ 150 ms p95 |
| Paper server create → running (artifact cached, image present) | ≤ 30 s (excluding Minecraft's own world generation) |
| Second server with same artifact | no re-download (cache hit) |
| Agent idle footprint | ≤ 40 MB RSS, ≤ 1 % of one core |
| File listing of 10 000 entries | ≤ 500 ms to first render (virtualised) |
