# Test node: `game@10.10.10.240`

User-provided Linux test node used for real end-to-end testing (inspected 2026-10-11).

## Facts
* Ubuntu 26.04.1 LTS, kernel 7.0, x86_64, 8 vCPU, 22 GiB RAM (≈ 12 GiB available), 97 GiB root LV (67 GiB free), 8 GiB swap.
* Docker 29.8.2 (API 1.56), cgroup v2, overlayfs, AppArmor + seccomp. User `game` (uid/gid 1000) is in the
  `docker` group (gid 983). **No passwordless sudo**; user lingering is off.
* Java 25 on the host (not used — workloads run in Temurin containers).
* Egress to fill.papermc.io and piston-meta.mojang.com works.

## Existing workloads — DO NOT TOUCH
`atm11-mc-1` (All The Mods 11, itzg/minecraft-server, port **25565**), `atm11-backups-1`, `atm11-motd-1`,
`atm11-watchtower-1`, `factorio` (27015/tcp, 34197/udp), `portainer` (8000, 9000, 9443),
`portainer_edge_agent`, `dockge` (5001), `minecraft-local-panel` (127.0.0.1:8765).
Their networks (`atm11_default`, `dockge_default`, `factorio_default`, `minecraft-local-panel_default`) and volumes
are off limits. The BlockForge agent only ever lists/stats/controls containers labelled
`io.blockforge.managed=true` and networks named `bf-*`.

Watchtower runs with `--label-enable`, so it only updates containers labelled
`com.centurylinklabs.watchtower.enable=true`; BlockForge workloads additionally carry
`com.centurylinklabs.watchtower.enable=false` defensively.

## BlockForge layout on the node
* Data root: `/home/game/blockforge` (owned by uid 1000; workloads run as 1000:1000 — no sudo/chown needed).
* Agent: Docker container `blockforge-agent` (`restart: unless-stopped`, survives logout without lingering),
  `network_mode: host`, user `1000:1000` + supplementary group 983 for `/var/run/docker.sock`,
  `/proc:/host/proc:ro`, `/sys:/host/sys:ro`, `/home/game/blockforge` bind-mounted at the identical path.
* Ports for BlockForge test servers: **25572–25600** (the allocation pool of the Mac control plane since
  2026-10-13; 25570–25600 were verified free on 2026-10-11, before the Windows-era servers took 25570/25571).
  Never 25565, 25570 or 25571: two untracked
  BlockForge containers from the Windows control plane (`bf-1cacbc31-…` on 25571, `bf-123abf52-…` on 25570) are
  left running and must not be touched. `scripts/e2e` refuses to start a server on 25565, 25570 or 25571.
* Capacity: set node allocatable memory to ≈ 6 GiB — the ATM11 server already uses most of the RAM.

## Deploying a new agent build
The node has no build tooling for BlockForge; images are built on the workstation and copied over:
```
docker compose -f infra/compose/docker-compose.agent.yml build agent          # on the workstation (linux/amd64)
docker save blockforge/node-agent:dev | gzip | ssh game@10.10.10.240 'gunzip | docker load'
ssh game@10.10.10.240 'cd ~/blockforge-deploy && docker compose up -d agent'  # recreates blockforge-agent only
ssh game@10.10.10.240 'docker logs --since 30s blockforge-agent'               # expect "connected to control plane"
```
`~/blockforge-deploy` holds the compose file (a copy of `infra/compose/docker-compose.agent.yml`) and `.env`
(`BF_DATA_ROOT=/home/game/blockforge`, `BF_DOCKER_GID=983`, control-plane URL `http://127.0.0.1:18081` since the
Mac move; it was `:18080` for the Windows workstation). The agent's identity and SFTP host key live in the data root,
so re-deploying keeps the enrollment. Workload containers keep running across an agent restart. Last deployed:
61669b0 (2026-10-12).

**Re-enrollment for the Mac control plane (2026-10-13):** the agent was enrolled fresh against the Mac control plane.
The Windows-era identity is backed up on the node in `~/blockforge-agent-identity-windows-20261013` and the old
`.env` in `~/blockforge-deploy/.env.bak-windows`; the two servers that identity managed (on 25570/25571) are
untracked by the Mac control plane and left running.

## Control-plane connectivity (dev)
The control plane runs on the dev Mac (`scripts/dev-up.sh --tunnel`, stop with `scripts/dev-down.sh`; earlier the
Windows workstation 192.168.10.159 with the `.ps1` helpers). The agent reaches it through an SSH reverse tunnel
opened from the Mac:

```
ssh -N -o ExitOnForwardFailure=yes -o ServerAliveInterval=15 -R 127.0.0.1:18081:127.0.0.1:8080 game@10.10.10.240
```

Agent URL: `http://127.0.0.1:18081` with `--insecure-allow-http` (allowed: loopback; transport encrypted by SSH).
Node port 18081 because the Windows workstation may still hold its tunnel on 18080 (`BF_TUNNEL_PORT` overrides the
port in `dev-up.sh`; the agent's URL must match). Verified 2026-10-11 (18080, Windows) and 2026-10-13 (18081, Mac).

## End-to-end scripts
`scripts/e2e/*.py` (see `scripts/e2e/README.md`) replace the uncommitted `.data/e2e_*.py` scripts that the
Phase 4b evidence below refers to; they did not survive the move off Windows and were rewritten.

## Phase 3 end-to-end evidence (2026-10-12)
* Allocation pool 25570–25600 (`0.0.0.0`, alias 10.10.10.240); allocating 25565 warned "already in use" (ATM11) and was removed.
* **Paper 26.3** (built-in template) on :25570 — created via API, running in ~40 s incl. first `eclipse-temurin:25-jre` pull;
  LAN SLP 9 ms; console `list`; graceful restart 14 s with world save; CPU/memory/JVM heap/players telemetry.
* **Vanilla Minecraft egg** (official Pterodactyl egg, imported) on :25571 — install container, EULA via file manager
  (stale write → 409, correct `baseSha256` → 200), SLP + JVM telemetry after the `kind: minecraft` fix.
* **SFTP** (agent :2022, enabled after the Phase 3 review fixes): key login with host-key fingerprint matching the panel,
  list/upload/download/rename/delete, symlink creation refused, `../` stays inside the data root (verified on the host),
  every mutation in the server activity log; read-only subuser can download but upload/delete/rename/mkdir/chmod are
  refused; login to a server the user is not on is refused.
  **LAN access to 2022 is blocked by the node's `ufw`** (Docker-published game ports bypass ufw; host-network listeners
  don't). Opening it needs `sudo ufw allow 2022/tcp` (or restricted to the LAN) by the node owner. Tests above ran through
  `ssh -L 12022:127.0.0.1:2022 game@10.10.10.240`.

## Phase 4a end-to-end evidence (2026-10-12)
* **Backup** of the running Paper 26.3 server (local storage): 2.0 s, 151 MiB, consistency `save-flush` — console shows
  `save-off` → `Saved the game` → `save-on`. The first attempt failed safely with SAVE_TIMEOUT (save-on still sent):
  Minecraft 26.3 prefixes command feedback with `System chat:`, which the matcher didn't accept — fixed (9241c35, 8798386),
  which also revealed that join/leave parsing was broken on 26.3.
* **Restore** while running (marker file deleted + junk file added first): safety backup (locked) → stop → restore → start
  in 18.2 s; marker restored, junk gone, server running.
* **Schedule** on the Vanilla egg server (`* * * * *`, only-when-online, two console tasks 5 s apart): cron run fired at the
  next minute and succeeded in 5.1 s, both `say` lines in the console, `lastRunStatus=succeeded`; schedule deleted.
* **API key** (servers.view + monitoring.view, 127.0.0.1/32, 1 day): `GET /servers` 200; restart → 403 (not granted);
  `/account/api-keys` → 403 (account routes refuse keys); last-used time/IP recorded; after revoke → 401.
* S3 storage not exercised live (no S3 endpoint for the node yet); covered by MinIO integration tests on the workstation.

### Re-run after the Phase 4a review fixes (2026-10-12, 6dda4da + agent d265046)
Control plane restarted on the fixed code (migration 0004 applied, agent reconnected).
* **Backup** of the running Paper 26.3 server: 4.1 s, 151.0 MiB, `save-flush`; console shows the hardened cycle —
  `Automatic saving is now disabled` (save-off acknowledged) → `Saving the game (this may take a moment!)` →
  `Saved the game` (accepted only after this save's progress line, `createSaveTracker`) → `Automatic saving is now enabled`.
* **Restore** while running (marker deleted, junk added): safety backup (locked) → stop → staged truncate restore →
  start in 32.3 s; marker back, junk gone, server running. Failed backup from the first live attempt kept as `failed`
  (retention: newest 10 per server, 7 days).
* **Schedule** (`* * * * *`, two console tasks 5 s apart): cron run succeeded in 5.1 s, both lines in the console.
* **API key**: `GET /servers` 200, restart 403, `/account/api-keys` 403, last use recorded, revoked → 401.
* `GET /account/permissions` 200 (52 global permissions for the owner, 2 servers); backups list pagination (`?limit=2`).
* No error-level lines in the control-plane log during the run.

## Phase 4b end-to-end evidence (2026-10-12, control plane f8d514d, agent still the pre-3125c66 build)
Control plane restarted with migration 0005 (`servers.extensions.view` in the role check; built-in roles synced).
* **Players, running Paper 26.3** (`.data/e2e_players.py`): overview from `list uuids` + list files + `server.properties`
  (0/10 online, online-mode, whitelist on); Mojang lookup `Notch` → `069a79f4-…`; whitelist-add, op, ban (reason),
  ban-ip, pardon, pardon-ip, deop, whitelist-remove all applied through the console and confirmed by the server's own
  feedback (`Added Notch to the whitelist`, `Made Notch a server operator`, `Banned Notch: BlockForge e2e`, …); kick of
  an offline player → `ok: false` "No player was found"; ban with `expiresAt` while running → 409 `requires_stopped`;
  `op @a` → 400. Lists re-read after each step matched.
* **Players, stopped Vanilla egg** (`.data/e2e_players_stopped.py`): whitelist-add, op (level 2, bypass), timed ban
  (expires 2100-01-01), ban-ip applied as file edits (`banned-players.json` written in the server's Gson format,
  source `BlockForge (owner)`); kick → 409 `not_running`; after start the server loaded every entry (whitelist, op
  level 2, ban, IP ban); cleanup through the console.
* **Plugins & mods on an outdated agent**: `GET …/extensions` 200 (scan `never`, upload policy), `POST …/extensions/scan`
  → 409 `agent_outdated` with `missingCapabilities: ["fs.hash", "jar.readEntries"]` (no timeout).
* Not yet live: sessions (no Minecraft client available on the LAN test).
* **Plugins & mods, agent 61669b0 deployed** (image built on the workstation, `docker save | ssh … docker load`,
  `docker compose up -d agent` in `~/blockforge-deploy`; agent reconnected, SFTP up, other containers untouched;
  `.data/e2e_extensions.py`): full scan 1.6 s; Modrinth search "chunky" (2 hits, both `match`); project + plan
  (1 file, no warnings, `restartRequired`); install job (SHA-512-verified `artifact.fetch` + rescan) 1.5 s →
  `Chunky-Bukkit-1.5.3.jar` source `modrinth`, metadata `Chunky`, loadable; disable → `.jar.disabled`, enable;
  upload of a generated plugin jar (transfer PUT + completion: metadata `BfE2E`, compatible); remove → keep area →
  history (`rollback.available`) → rollback job restored it; restart → Paper console `[Chunky] Enabling Chunky v1.5.3`.
  **Bug found:** update checks (`GET …/extensions/updates`) → 404 and hash identification fails: the control plane's
  pinned HTTPS transport (`catalog/safe-fetch.ts`) sends every request as a GET without the caller's method, body or
  headers (so Modrinth POSTs 404 and no User-Agent is sent); tests injected a transport and missed it.
* **After the transport fix (11944b7, ad738e1; control plane restarted):** full scan identifies `Chunky-Bukkit-1.5.3.jar`
  on Modrinth by SHA-512 (`fALzjamp`, 1.5.3) with no identification errors; `GET …/extensions/updates` 200 (1.5.3 is
  current, no problem); project route lists releases only by default (`luckperms` → `v5.5.71-bukkit`); a jar copied in
  through the file manager (as over SFTP) is identified on the next incremental scan (title, version, metadata) and
  removed again through the keep area. Follow-ups noted: identified on-disk copies are labelled `source: "modrinth"`
  (contract says found-on-disk = `unknown` + a Modrinth ref), and two copies of the same plugin are not flagged.
* No error-level lines in the control-plane log.

## Phase 4b sign-off re-run (2026-10-13, main afebd2d)
Mac control plane on main afebd2d, agent re-enrolled through the 18081 tunnel; `scripts/e2e/*` (commit d11bb86) run in
order against `e2e-paper` (Paper 26.3, 25572) and `e2e-vanilla` (Pterodactyl Vanilla egg, 26.3, 25573). All PASS:
`setup_servers.py` 8 checks, `e2e_players.py` 49, `e2e_players_stopped.py` 46, `e2e_extensions.py` 32,
`e2e_ext_updates.py` 24 (159 in total). No error-level lines in the control-plane log.
* **Players, running Paper:** overview from `list uuids` (0/20, online-mode, whitelist on), Mojang lookup `Notch` →
  `069a79f4-…`; all eight console actions confirmed by the server's feedback and re-read lists; kick of an offline
  player → `ok: false` "No player was found"; `expiresAt` / op level while running → 409 `requires_stopped`; `op @a`,
  an IPv6 ban and an unknown field → 400.
* **Players, stopped Vanilla egg:** file edits in the server's Gson format (`expires` "2100-01-01 00:00:00 +0000",
  IP ban `forever`, ops level 2 + bypass); kick / whitelist-reload → 409 `not_running`; after start the server's own
  `whitelist list`, `banlist players`, `banlist ips` and `op` show every entry loaded; cleanup through the console.
* **Plugins & mods:** full scan 1.2 s; install job (fetch + rescan) 1.2 s → Chunky 1.5.3 (`modrinth`, SHA-512 equal
  to the plan, loadable); disable/enable; upload → remove → rollback; restart → `[Chunky] Enabling Chunky v1.5.3`.
* **Updates:** `GET …/extensions/updates` 200; Chunky 1.4.40 copied in through the file manager identified by SHA-512
  (`P3y2MXnd`) and offered 1.5.3; then 1.4.40 installed through the install route and **updated to 1.5.3 through
  `POST …/extensions/updates/apply`** (job 1.2 s, result `updated`, history `update` 1.4.40 → 1.5.3 with
  `rollback.available`) — the first live verification of update apply.
* Still open from this run: identified on-disk copies are labelled `source: "modrinth"` (see above); the project
  route's prerelease check used `luckperms`, which has no prereleases for 26.3 (the scripts now use `viaversion`).
