# BlockForge node agent

Go agent that runs on every Minecraft node. It connects **outbound** to the control plane over a
WebSocket (`/agent/v1/connect`), authenticates with its own Ed25519 key, and executes only the fixed,
signed command catalogue from [`docs/architecture/agent-protocol.md`](../../docs/architecture/agent-protocol.md):
hardened Docker workloads, sandboxed file operations, allowlisted artifact downloads, log streaming,
console input, host/workload telemetry, JVM probe stats and Minecraft Server List Ping.

```
cmd/blockforge-agent      CLI: enroll | run | init-dirs | version
internal/protocol         wire types mirroring packages/contracts (golden fixtures), zod-equivalent validator, command verification
internal/auth             agent key files, BFAgent tokens, staged-rotation proofs
internal/config           agent.json, control-plane URL policy, image + download-host allowlists
internal/journal          durable command seen-set (commands.journal)
internal/agent            executor (verify → replay → validate → run), handlers, wiring, fake control plane tests
internal/transport        WebSocket session, reconnect backoff (full jitter), priority outbox
internal/workload         Docker driver, hardening, egg runtime, install containers, restart policy, events, logs, console
internal/fsops            os.Root sandbox, atomic writes, archive extraction, copy/compress/chmod/find
internal/artifact         artifact.fetch (+ content-addressed cache) and fs.transfer.push/pull
internal/sftpd            built-in SFTP server (control-plane auth, sandboxed sessions, activity events)
internal/metrics, facts   host (gopsutil) and workload (Docker stats, JVM probe, SLP) telemetry
internal/minecraft        Server List Ping client
internal/jvmprobe         embedded services/jvm-probe jar (+ recorded sha256)
```

## Build

```sh
export PATH=/c/Users/lmari/sdk/go/bin:$PATH        # dev workstation (portable Go 1.27)
cd services/node-agent
go vet ./... && go test ./...
CGO_ENABLED=0 GOOS=linux GOARCH=amd64 go build -trimpath -ldflags "-s -w -X github.com/blockforge/node-agent/internal/version.Version=0.1.0" -o bin/blockforge-agent ./cmd/blockforge-agent
```

The JVM probe jar is built reproducibly with `services/jvm-probe/build.sh` (Docker, `eclipse-temurin:21-jdk`,
`javac --release 8`, fixed jar timestamps) and committed as `internal/jvmprobe/jvm-probe.jar` with its sha256;
a unit test fails if the jar and the recorded checksum diverge.

## Tests

| Command | What it covers |
|---------|----------------|
| `go test ./...` | golden fixtures, validator, sandbox attacks, artifact fetch (TLS test server), SLP fake server, restart policy, rate limiter, backoff, full agent ↔ fake control plane (enroll, hello/welcome, signed commands, replay, rotation, transfers, restart replay, approval gating) |
| `scripts/test-linux.sh -race ./...` | same suite in a `golang:1.27` Linux container (real symlinks, FIFOs, /proc) |
| `scripts/test-linux.sh -tags integration ./...` | real Docker: workload lifecycle, hardening as applied by the engine, console, logs, stats, restart policy, unmanaged-container safety |
| `BF_IT_PAPER=1 scripts/test-linux.sh -tags integration -run TestPaperEndToEnd ./internal/agent/` | real Paper server via signed commands (download + sha256 from fill-data.papermc.io, start, `Done (`, SLP, JVM probe, console, graceful stop) |
| `BF_IT_EGG=1 scripts/test-linux.sh -tags integration -run Egg ./internal/agent/` | official Pterodactyl eggs through signed commands: Vanilla Minecraft (`yolks:java_21`, install script, done string, SLP, JVM probe, `stop`) and TeamSpeak 3 (SIGINT stop) — fixtures in `internal/agent/testdata` |
| `BF_IT_COMPOSE=1 go test -tags integration -run TestComposeAgent ./internal/agent/` | the containerised agent from `infra/compose/docker-compose.agent.yml` against a fake control plane on the host |

`scripts/test-linux.sh` mounts the Docker socket, uses `--network host` and bind-mounts
`BF_IT_DATA_ROOT` (default `/var/lib/blockforge-it`) at the identical path, because workload bind
sources are resolved by the Docker daemon on its host.

## Enroll and run

```sh
blockforge-agent enroll --url https://cp.example.com --token bfe_xxxxxxxxxxxxxxxx_xxxxxxxx… \
    [--name mc-node-1] [--config-dir /etc/blockforge] [--data-root /var/lib/blockforge] [--ca-file ca.pem]
blockforge-agent run [--config-dir /etc/blockforge]
```

* `enroll` generates the Ed25519 key locally (`agent.key`, 0600), calls `POST /agent/v1/enroll`, and stores
  `agent.json` (0600) with the node id, control-plane URL and the **pinned** control-plane signing key.
* `http://` is refused. `--insecure-allow-http` only permits `localhost`, `127.0.0.1`, `::1` and
  `host.docker.internal` (development, SSH tunnels). `--ca-file` pins a private CA.
* The token can also be passed as `BLOCKFORGE_ENROLL_TOKEN` (keeps it out of the process list).
* `IMAGE_NOT_ALLOWED` is returned when a spec's image is not on `imageAllowlist`.
* Workload UID/GID default to `1000:1000` when the agent runs as root, otherwise to the agent's own
  uid/gid (non-root agents cannot chown, so workloads must run as the agent user). Override with
  `--workload-uid/--workload-gid`.

`agent.json` keys you may edit: `dataRoot`, `workloadUid/Gid`, `imageAllowlist` (entries `repo:*` = any
tag of exactly that repo, or exact references; default `eclipse-temurin:*`, `ghcr.io/pterodactyl/yolks:*`,
`ghcr.io/pterodactyl/installers:*`, `ghcr.io/parkervcp/yolks:*`, `ghcr.io/parkervcp/installers:*`; a config
still holding the 0.1.0 default `["eclipse-temurin:*"]` is upgraded on load), `downloadHostAllowlist`
(exact hosts, `host:port`, or `*.domain`; defaults are the Mojang/Paper/Purpur/Fabric/Forge/NeoForge/Modrinth
hosts), `netIfaceExclude` (glob patterns; default skips `lo`, `veth*`, `docker*`, `br-*` and common CNI
devices), `dockerHost` (e.g. `unix:///run/user/1000/docker.sock` for rootless Docker or a Podman socket),
`maxConcurrentCommands`, `artifactCacheMaxBytes` (default 10 GiB), `sftp.enabled` (default true) and
`sftp.listen` (default `0.0.0.0:2022`).

Environment overrides: `BLOCKFORGE_SFTP_LISTEN`, `BLOCKFORGE_SFTP_ENABLED`, `BLOCKFORGE_CONFIG_DIR`, `BLOCKFORGE_DATA_ROOT`, `BLOCKFORGE_LOG_LEVEL`,
`BLOCKFORGE_HOSTNAME`, `DOCKER_HOST`, and the gopsutil host-path variables `HOST_PROC`, `HOST_SYS`,
`HOST_ETC`, `HOST_ROOT` for containerised agents.

## Install as a systemd service

```sh
sudo useradd --system --home-dir /var/lib/blockforge --shell /usr/sbin/nologin blockforge
sudo usermod -aG docker blockforge
sudo install -m 0755 bin/blockforge-agent /usr/local/bin/blockforge-agent
sudo install -d -o blockforge -g blockforge -m 0700 /etc/blockforge
sudo install -d -o blockforge -g blockforge -m 0755 /var/lib/blockforge
sudo -u blockforge BLOCKFORGE_ENROLL_TOKEN=bfe_… blockforge-agent enroll --url https://cp.example.com --name "$(hostname)"
sudo install -m 0644 packaging/blockforge-agent.service /etc/systemd/system/blockforge-agent.service
sudo systemctl daemon-reload && sudo systemctl enable --now blockforge-agent
journalctl -u blockforge-agent -f
```

**Data root under `/home`** (e.g. `/home/game/blockforge`): the unit's `ProtectHome=yes` hides `/home`
completely, so `ReadWritePaths` alone cannot expose a path below it. Install the shipped drop-in after
editing its path (it switches to `ProtectHome=read-only` and adds the data root to `ReadWritePaths`;
optionally `User=`/`Group=` of the login user who owns the data root):

```sh
sudo install -D -m 0644 packaging/drop-ins/home-data-root.conf \
    /etc/systemd/system/blockforge-agent.service.d/home-data-root.conf
sudo systemctl daemon-reload && sudo systemctl restart blockforge-agent
```

Both the plain unit and unit + drop-in pass `systemd-analyze verify` (exposure 1.6 / 1.7).

The unit runs as `blockforge` with `NoNewPrivileges`, an empty capability bounding set,
`ProtectSystem=strict` (+ `ReadWritePaths=/var/lib/blockforge /etc/blockforge`), `ProtectHome`, private
`/tmp` and devices, kernel/cgroup/clock protection, namespace and address-family restrictions and a
`@system-service` syscall filter. Membership in `docker` is still root-equivalent; the agent compensates
by exposing no generic container or shell API. Rootless Docker/Podman: set `dockerHost` in `agent.json`
and drop `SupplementaryGroups=docker`.

## Run as a container (Docker Desktop dev box or a Linux node)

`infra/compose/docker-compose.agent.yml` (image: `infra/containers/node-agent/Dockerfile`, ~20 MB
distroless static image) is parameterised by `BF_DATA_ROOT`, `BF_UID`/`BF_GID`, `BF_DOCKER_GID`
and `BF_CP_URL`:

```sh
# Docker Desktop, control plane on the Windows host at :8080
docker compose -f infra/compose/docker-compose.agent.yml build
BLOCKFORGE_ENROLL_TOKEN=bfe_… docker compose -f infra/compose/docker-compose.agent.yml run --rm \
    -e BLOCKFORGE_ENROLL_TOKEN agent enroll --url http://host.docker.internal:8080 --insecure-allow-http --name dev
docker compose -f infra/compose/docker-compose.agent.yml up -d agent

# Linux node (non-root, docker group 983, control plane through an SSH reverse tunnel)
export BF_DATA_ROOT=/home/game/blockforge BF_DOCKER_GID=983 BF_CP_URL=http://127.0.0.1:18080
BLOCKFORGE_ENROLL_TOKEN=bfe_… docker compose -f infra/compose/docker-compose.agent.yml run --rm \
    -e BLOCKFORGE_ENROLL_TOKEN agent enroll --url "$BF_CP_URL" --insecure-allow-http --name test-node
docker compose -f infra/compose/docker-compose.agent.yml up -d agent
```

The agent container runs as `BF_UID:BF_GID` (default 1000:1000) plus the socket's group, read-only,
`cap_drop: ALL`, `no-new-privileges`, `restart: unless-stopped`, with `/proc` and `/sys` mounted
read-only at `/host/proc` and `/host/sys`. A one-shot `agent-init` service (root, `CAP_CHOWN` only,
no network) makes sure the top-level data root exists and is owned by `BF_UID:BF_GID`. The config
directory lives at `$BF_DATA_ROOT/agent` (never mounted into workloads — they only see their own
`servers/<id>/data`).

**Why `network_mode: host`.** Server List Ping must reach each workload. Workloads sit on `bf-*`
bridge networks (backends behind a Velocity proxy often publish no port at all), and container IPs on
a bridge are routable from the host network namespace but not from a container on a different
bridge (verified on Docker Desktop 29.8: host netns → `172.20.0.2:25565` connects, default bridge →
refused). Running the agent in the host namespace gives it exactly the reachability a
systemd-installed agent has, lets it reach loopback-only control-plane tunnels (`127.0.0.1:18080`),
and makes host network metrics describe the host's NICs. SLP targets, in order: the container IP on a
`bf-*` network, any other container IP, then a published port on the host (`0.0.0.0` → `127.0.0.1`).
The port comes from `server.properties` (`server-port`) / `velocity.toml` (`bind`), then the spec,
then 25565/25577.

Filesystems: without `HOST_ROOT` only the filesystem holding the data root is reported (the agent can
always `statfs` it because it is mounted at the same path); mount `/:/host/root:ro,rslave` and set
`HOST_ROOT=/host/root` to report every host filesystem.

## Eggs, install containers, artifact cache, SFTP

* **Egg runtime** (`entrypoint: "image"`): the image's ENTRYPOINT/CMD are kept (yolks evaluate `STARTUP` and
  `exec` the game), the data dir is mounted at `dataMountPath` (`/home/container`), which is also `WorkingDir`
  and `HOME`; hardening is identical to argv workloads (UID/GID, cap-drop ALL, no-new-privileges, limits;
  read-only rootfs unless `readOnlyRootfs: false`, tmpfs `/tmp` either way). docker-init is PID 1 in both
  modes so stop signals reach the game. Stop: console command or signal, then SIGTERM, then SIGKILL after
  15 s; `stop: null` = SIGTERM → SIGKILL after 15 s.
* **`workload.install`**: container `bf-<id>-install` from an allowlisted image, script at
  `/mnt/install/install.sh` (read-only, CRLF normalised), data at `/mnt/server`; root inside the container
  with only `CHOWN, DAC_OVERRIDE, FOWNER, SETUID, SETGID`, no-new-privileges, memory/CPU/pids limits, default
  bridge network, writable image rootfs (scripts install packages), no Docker socket. The wrapper
  `<sh> /mnt/install/install.sh; rc=$?; chown -R <uid>:<gid> /mnt/server; exit $rc` hands the files back
  also on failure; after a timeout/OOM kill a short follow-up container does the chown. Output streams as
  `logs` frames with `source: "install"` (own ring buffer and rate limit); the result has the last 200 lines.
  `BUSY` while the workload runs, a restart is pending, or another install is in flight; start/remove are
  `BUSY` during an install. Install containers never drive workload events or the restart policy and are
  removed afterwards (leftovers from a crashed agent are removed at start-up). The agent itself never needs
  root for this.
* **Artifact cache** (`artifact.fetch` with a checksum and `cache: true`): `<dataRoot>/cache/artifacts/<alg>/<value>`
  (0700 dir, 0444 entries, outside every sandbox). Entries are verified on download and again while being
  copied into a sandbox (corrupt entries are evicted and re-downloaded); concurrent fetches of one artifact
  share a single download; LRU eviction above `artifactCacheMaxBytes`; the host allowlist still applies on a
  hit. Entries are **copied, not hard-linked**: a hard link shares the inode, so an in-place writer in one
  server (an egg's `curl -o server.jar`, a plugin updater, a root install container) would change the
  cached file and every other server's copy.
* **SFTP** (`internal/sftpd`, `0.0.0.0:2022`): Ed25519 host key `<configDir>/sftp_host_ed25519_key` (0600,
  created on first start; fingerprint in `NodeFacts.sftp`). Username `<username>.<serverShortId>` is checked
  locally, then password or public key is verified by `POST <cp>/agent/v1/sftp/auth` (BFAgent header). Each
  session gets an `os.Root` on its workload data dir with the same path rules as `fs.*`; `read`/`write`
  permissions and the template denylist (gitignore subset) are enforced; symlink/hardlink creation,
  ownership and size setstat are refused (permission bits masked to 0777 and timestamps are allowed); no
  shell, exec or port forwarding. Re-authentication at `expiresAt` (failure closes the session),
  10 sessions per user+server, 3 failed logins per IP per minute (then refused locally), 10 min idle
  timeout, 30 s handshake timeout, packet sizes bounded by pkg/sftp (256 KiB). Mutations are reported as
  `sftp.activity` events (≤ 1 s, ≤ 100 actions). It is the agent's only inbound port: open `2022/tcp` in the
  host firewall only for the clients that need it.

## Security model (summary)

* **Commands**: Ed25519 signature over the exact body with the pinned control-plane key → nodeId →
  expiry (+30 s) → `issuedAt <= expiresAt` → `issuedAt <= now + 30 s` → lifetime ≤ 15 min (overflow-safe) → seen-set (15-min result cache + fsync'd `commands.journal`
  that survives restarts; a failed append is rolled back, and on an unrecoverable write/fsync error the
  journal fails closed — commands get a retryable `INTERNAL` — until it has been rewritten atomically) → payload validation equivalent to the zod schemas → handler. Rejected,
  unauthenticated ids never enter the seen-set. Pending (unapproved) nodes only run `node.facts`.
* **Containers**: `bf-<workloadId>`, labels `io.blockforge.managed=true`, `io.blockforge.workload`,
  spec hash, `com.centurylinklabs.watchtower.enable=false`; UID/GID 1000 (configurable), cap-drop ALL,
  no-new-privileges, read-only rootfs + tmpfs `/tmp`, memory = memory+swap, NanoCPUs, pids limit,
  never privileged, never host network, never a Docker socket, Docker restart policy off (the agent
  runs its own, which never fires after a deliberate stop/kill). Only containers with the managed
  label and networks named `bf-*` are ever listed, inspected, attached to or modified; a same-named
  unlabelled container is refused. An existing `bf-*` network is only joined if it carries
  `io.blockforge.managed=true` and `io.blockforge.node=<this node id>` (set when the agent creates it);
  anything else is a `CONFLICT`, checked before any state is persisted, and is never pruned.
* **Files**: every `fs.*` path is validated (no absolute paths, `..`, NUL, backslashes, drive letters,
  device names, no mutation of the data root itself) and resolved with `os.Root`, so symlinks can never
  leave `<dataRoot>/servers/<id>/data`. FIFOs/devices are refused without blocking. Archives are
  pre-validated (symlinks, hardlinks, devices, FIFOs, absolute paths, `..` reject the whole archive) and
  extraction counts the bytes actually decompressed.
* **Downloads**: HTTPS only, host allowlist on the initial URL and every redirect, size limit, idle
  timeout, streaming sha1/sha256/sha512 verification into a temp file that is renamed only on success.
