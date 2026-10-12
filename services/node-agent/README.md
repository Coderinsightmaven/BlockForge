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
internal/workload         Docker driver, hardening, restart policy, events, logs follower, console attach
internal/fsops            os.Root sandbox, atomic writes, archive extraction
internal/artifact         artifact.fetch + fs.transfer.push/pull
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
* Workload UID/GID default to `1000:1000` when the agent runs as root, otherwise to the agent's own
  uid/gid (non-root agents cannot chown, so workloads must run as the agent user). Override with
  `--workload-uid/--workload-gid`.

`agent.json` keys you may edit: `dataRoot`, `workloadUid/Gid`, `imageAllowlist` (entries `repo:*` = any
tag of exactly that repo, or exact references; default `eclipse-temurin:*`), `downloadHostAllowlist`
(exact hosts, `host:port`, or `*.domain`; defaults are the Mojang/Paper/Purpur/Fabric/Forge/NeoForge/Modrinth
hosts), `netIfaceExclude` (glob patterns; default skips `lo`, `veth*`, `docker*`, `br-*` and common CNI
devices), `dockerHost` (e.g. `unix:///run/user/1000/docker.sock` for rootless Docker or a Podman socket),
`maxConcurrentCommands`.

Environment overrides: `BLOCKFORGE_CONFIG_DIR`, `BLOCKFORGE_DATA_ROOT`, `BLOCKFORGE_LOG_LEVEL`,
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

## Security model (summary)

* **Commands**: Ed25519 signature over the exact body with the pinned control-plane key → nodeId →
  expiry (+30 s) → lifetime ≤ 15 min → seen-set (15-min result cache + fsync'd `commands.journal`
  that survives restarts) → payload validation equivalent to the zod schemas → handler. Rejected,
  unauthenticated ids never enter the seen-set. Pending (unapproved) nodes only run `node.facts`.
* **Containers**: `bf-<workloadId>`, labels `io.blockforge.managed=true`, `io.blockforge.workload`,
  spec hash, `com.centurylinklabs.watchtower.enable=false`; UID/GID 1000 (configurable), cap-drop ALL,
  no-new-privileges, read-only rootfs + tmpfs `/tmp`, memory = memory+swap, NanoCPUs, pids limit,
  never privileged, never host network, never a Docker socket, Docker restart policy off (the agent
  runs its own, which never fires after a deliberate stop/kill). Only containers with the managed
  label and networks named `bf-*` are ever listed, inspected, attached to or modified; a same-named
  unlabelled container is refused.
* **Files**: every `fs.*` path is validated (no absolute paths, `..`, NUL, backslashes, drive letters,
  device names, no mutation of the data root itself) and resolved with `os.Root`, so symlinks can never
  leave `<dataRoot>/servers/<id>/data`. FIFOs/devices are refused without blocking. Archives are
  pre-validated (symlinks, hardlinks, devices, FIFOs, absolute paths, `..` reject the whole archive) and
  extraction counts the bytes actually decompressed.
* **Downloads**: HTTPS only, host allowlist on the initial URL and every redirect, size limit, idle
  timeout, streaming sha1/sha256/sha512 verification into a temp file that is renamed only on success.
