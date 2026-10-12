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
* Ports for BlockForge test servers: **25570–25600** (verified free). Never 25565.
* Capacity: set node allocatable memory to ≈ 6 GiB — the ATM11 server already uses most of the RAM.

## Control-plane connectivity (dev)
The control plane runs on the dev workstation (192.168.10.159). The agent reaches it through an SSH
reverse tunnel opened from the workstation:

```
ssh -N -o ExitOnForwardFailure=yes -o ServerAliveInterval=15 -R 127.0.0.1:18080:127.0.0.1:8080 game@10.10.10.240
```

Agent URL: `http://127.0.0.1:18080` with `--insecure-allow-http` (allowed: loopback; transport encrypted by SSH).
Verified 2026-10-11: tunnel established, remote `127.0.0.1:18080` reached a workstation service.

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
