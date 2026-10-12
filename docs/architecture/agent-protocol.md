# Agent Protocol v1

The authoritative machine-readable definition is `packages/contracts/src/agent/*.ts` (zod).
Golden JSON fixtures in `packages/contracts/fixtures/agent/` are loaded by **both** the
TypeScript tests and the Go tests (`services/node-agent/internal/protocol`), so any drift
between the two implementations fails CI.

## 1. Encoding conventions

* JSON, UTF-8. WebSocket text frames only.
* Timestamps: **integer Unix milliseconds** (`ts`, `issuedAt`, `expiresAt`).
* Byte quantities are integers in bytes; rates are bytes/second (floats allowed).
* Percentages are 0–100 floats. Per-workload CPU percent is relative to **one core**
  (200 = two full cores), matching `docker stats`.
* Base64 means **base64url without padding** (RFC 4648 §5).
* IDs are UUID v4 strings unless stated.
* Unknown fields MUST be ignored by receivers (forward compatibility). Unknown command types
  MUST be answered with error code `UNSUPPORTED_COMMAND`.

## 2. Enrollment

1. An administrator creates an enrollment token in the UI (`POST /api/v1/nodes/enrollment-tokens`).
   Token string: `bfe_<tokenId>_<secret>` where `tokenId` is 16 lowercase hex chars and
   `secret` is 32 random bytes base64url. Only `sha256(secret)` is stored. Tokens expire
   (default 1 h, max 7 d), are single-use, and may require manual approval.
2. On the node: `blockforge-agent enroll --url https://cp.example.com --token bfe_...`.
   The agent generates an Ed25519 keypair, stores the private key at
   `<configDir>/agent.key` (mode 0600), and calls:

```
POST /agent/v1/enroll
{ "token": "bfe_…", "publicKey": "<b64url 32 bytes>", "agentVersion": "0.1.0",
  "protocolVersion": 1, "facts": NodeFacts, "nodeName": "optional-suggested-name" }
→ 201 { "nodeId": "<uuid>", "approved": true,
        "controlPlaneSigningKey": "<b64url Ed25519 public key>",
        "heartbeatIntervalMs": 15000, "metricsIntervalMs": 5000 }
```

   The agent persists `nodeId`, the control-plane URL and the control-plane signing key
   (pinned) in `<configDir>/agent.json`. Errors: `401 ENROLLMENT_TOKEN_INVALID` (unknown,
   used, expired — deliberately indistinguishable), `400 VALIDATION_FAILED`.
3. Agents refuse `http://` control-plane URLs. `--insecure-allow-http` exists for local
   development only and is accepted **only** when the URL host is one of
   `INSECURE_HTTP_ALLOWED_HOSTS` (`localhost`, `127.0.0.1`, `::1`, `host.docker.internal`);
   any other host is refused even with the flag. `--ca-file` lets an operator pin a private CA.

## 3. Agent authentication (connect + agent HTTP endpoints)

Every agent request carries `Authorization: BFAgent <claims>.<sig>` where `claims` is
base64url(JSON) and `sig` is base64url(Ed25519 signature over the ASCII bytes of the
`<claims>` segment).

```json
{ "nid": "<nodeId>", "aud": "blockforge-control-plane", "iat": 1760000000000,
  "exp": 1760000060000, "jti": "<16+ random bytes b64url>" }
```

Control plane verification: signature valid for one of the node's usable keys (`active`, or
a `pending` key from an in-progress rotation — see §3.1); node not revoked; `aud` matches;
`exp - iat <= 120000`; `now` within `[iat - 30000, exp]`; `jti` not previously seen.
**Replay state is durable and shared**: each accepted `jti` is inserted into the
`agent_auth_jti` table (primary key `jti`, pruned after `exp`) inside the authentication
step, so a restart or a second control-plane replica cannot accept the same token again.
Pending (unapproved) nodes may connect but receive no commands except `node.facts`.

### 3.1 Credential rotation (staged, bounded overlap)

1. Control plane sends `credentials.rotate`. The agent generates a *next* keypair, persists it
   as `agent.key.next` (the current `agent.key` is untouched) and returns
   `{publicKey, proof}` where `proof` = Ed25519 signature by the **next** key over the UTF-8
   string `ROTATION_PROOF_PREFIX + nodeId + ":" + commandId` (`blockforge-rotate:<nodeId>:<cmdId>`).
2. Control plane verifies the proof and stores the key as a `pending` credential (expires after
   `credentialRotationPendingTtlMs`, 15 min). Both `active` and `pending` keys authenticate.
3. After sending the result the agent closes the WebSocket and reconnects authenticating with
   the next key. On the first successful authentication with the pending key the control plane
   atomically marks it `active` and the previous key `rotated` (no longer accepted). The agent
   promotes `agent.key.next` → `agent.key` only after `welcome` is received.
4. If reconnecting with the next key fails with 401 (e.g. pending key expired), the agent falls
   back to the current key and discards `agent.key.next`. Rotation never leaves a node with
   zero usable keys.

Endpoints: `GET /agent/v1/connect` (WebSocket upgrade), `POST /agent/v1/transfers/:id`
(agent uploads a file stream), `GET /agent/v1/transfers/:id` (agent downloads a stream).

## 4. Message envelope

### Control plane → agent

```json
{ "t": "cmd", "body": "<JSON string of CommandBody>", "sig": "<b64url signature over UTF-8 bytes of body>" }
{ "t": "welcome", "nodeId": "…", "serverTime": 1760000000000, "approved": true,
  "heartbeatIntervalMs": 15000, "metricsIntervalMs": 5000 }
```

`CommandBody`:

```json
{ "id": "<uuid>", "nodeId": "<uuid>", "type": "workload.start",
  "issuedAt": 1760000000000, "expiresAt": 1760000300000, "payload": { … } }
```

The signature covers the exact `body` string, so no canonical-JSON scheme is needed.
Agent checks, in order: signature valid for the pinned control-plane key → `nodeId` equals
its own → `now <= expiresAt + 30000` → `expiresAt - issuedAt <= 900000` → `id` not in the
seen-set → payload validates. A duplicate `id` re-sends the cached result if the command
finished (results cached 15 min) or is ignored while still running (idempotent retry). Failed
checks are answered with `result` + error code `COMMAND_REJECTED` (or `VALIDATION_FAILED` for
payloads) and logged locally.

**Durable seen-set.** Before executing any side effect the agent appends `{id, expiresAt}` to
an fsync'd journal (`<configDir>/commands.journal`), pruned of expired entries on start-up and
periodically. After an agent restart, a replayed command whose id is in the journal is rejected
(`COMMAND_REJECTED`, "duplicate"). In addition, every command is designed so that repeating it
is harmless (`workload.ensure` by spec hash, `fs.write` with `ifMatchSha256`, start/stop
converge to a state) — replay protection and idempotency are defence in depth.

The control plane may send `welcome` again on an open session (e.g. when an administrator
approves a pending node: `approved` flips to `true`). Agents must apply the new values in place.

### Agent → control plane

| `t` | Shape | Purpose |
|-----|-------|---------|
| `hello` | `{agentVersion, protocolVersion, ts, facts: NodeFacts, capabilities: string[], workloads: WorkloadStatus[]}` | First frame after connect; control plane replies `welcome`. |
| `heartbeat` | `{ts, uptimeMs}` | Every `heartbeatIntervalMs`. Node becomes `unreachable` after 3 missed intervals. |
| `progress` | `{id, ts, stage, message?, percent?}` | Long-running command progress. |
| `result` | `{id, ts, ok: true, data}` or `{id, ts, ok: false, error: {code, message, retryable, details?}}` | Exactly one per command. |
| `metrics` | `{ts, node: NodeMetricSample, workloads: WorkloadMetricSample[]}` | Every `metricsIntervalMs`; exactly one node sample per frame. |
| `event` | `{ts, event: "workload.state" \| "workload.oom" \| "agent.warning", data}` | Asynchronous state changes. |
| `logs` | `{workloadId, lines: [{ts, stream: "stdout"\|"stderr", line}], dropped?: n}` | Continuous stdout/stderr of managed workloads (≤ 200 lines/s/workload sustained, burst 2000; excess dropped and counted). Lines truncated at 8 KiB. |

## 5. Error codes

`VALIDATION_FAILED`, `UNSUPPORTED_COMMAND`, `COMMAND_REJECTED`, `NOT_FOUND`,
`ALREADY_EXISTS`, `CONFLICT` (e.g. `ifMatchSha256` mismatch), `PATH_FORBIDDEN`,
`QUOTA_EXCEEDED`, `CHECKSUM_MISMATCH`, `DOWNLOAD_FAILED`, `HOST_NOT_ALLOWED`,
`IMAGE_NOT_ALLOWED`, `RUNTIME_ERROR` (Docker failure), `TIMEOUT`, `BUSY`, `INTERNAL`.

### 5.1 Behaviour notes (agreed with the Go implementation)
* `fs.write` with `ifMatchSha256` set and the file missing → `CONFLICT` with `details.currentSha256: null`;
  `ifMatchSha256: null` and the file exists → `ALREADY_EXISTS`.
* `WorkloadStatus.state` is `restarting` while an agent-side restart (restart policy back-off) is pending.
* `containerId` is Docker's 12-character short id.
* `node.probe` returns `reachable: true` with `error` set when TCP connects but the Minecraft SLP exchange fails.
* `agent.warning` events use codes such as `WORKLOAD_RESTART_LIMIT` (restart policy exhausted).
* `fs.transfer.pull` verifies an optional `X-BlockForge-Sha256` response header from the control plane.
* `workload.state` events are re-sent after every (re)connect/resync — consumers must be idempotent.
* After an agent restart, a replayed command id found in the journal is rejected as `COMMAND_REJECTED`
  ("duplicate") and its original outcome is unknown to the agent. The control plane must then reconcile
  (`workload.status` / `fs.stat`) and, if needed, re-issue the operation under a **new** command id.
* `fs.list` returns at most 50 000 entries and sets `truncated: true` when capped.

## 6. Command catalogue

Mutation commands (`fs.write`, `fs.mkdir`, `fs.rename`, `fs.delete`, `fs.extract.archivePath`,
`fs.transfer.*`, `artifact.fetch.destPath`) use `MutableRelativePath`, which rejects any path
that resolves to the data root itself (`""`, `"."`, `"./"`, …); the agent enforces the same
rule independently after normalisation. Read-only commands may target the root.

Host percentages (CPU, per-core, iowait, steal, disk busy) are bounded to 0–100 by the schema;
agents clamp sampling jitter before sending. Workload `cpuPct` is per-core and may exceed 100.

All workload-scoped paths are **relative to the workload data root**
(`<dataRoot>/servers/<workloadId>/data`). The agent resolves them with symlink-safe
logic (`openat`-style walk / `filepath.EvalSymlinks` + prefix check, reject `..`, absolute
paths, NUL bytes, Windows drive letters and device names) and refuses anything outside.

| Type | Payload | Result |
|------|---------|--------|
| `node.facts` | `{}` | `NodeFacts` |
| `node.probe` | `{host, port, kind: "tcp"\|"minecraft", timeoutMs}` | `{reachable, latencyMs?, error?, minecraft?: SlpStatus}` |
| `workload.ensure` | `WorkloadSpec` | `{created, changed, status: WorkloadStatus}` |
| `workload.start` | `{workloadId}` | `WorkloadStatus` |
| `workload.stop` | `{workloadId, timeoutMs}` — writes `spec.stopCommand` to stdin, waits, then SIGTERM, then SIGKILL after 15 s | `WorkloadStatus` |
| `workload.kill` | `{workloadId}` | `WorkloadStatus` |
| `workload.remove` | `{workloadId, deleteData}` | `{}` |
| `workload.status` | `{workloadId?}` | `{workloads: WorkloadStatus[]}` |
| `workload.console` | `{workloadId, line}` — `line` ≤ 1024 chars, no CR/LF/NUL | `{}` |
| `workload.logs.tail` | `{workloadId, lines (≤5000), sinceTs?}` | `{lines: LogLine[]}` |
| `fs.list` | `{workloadId, path}` | `{entries: FileEntry[]}` |
| `fs.stat` | `{workloadId, path}` | `FileEntry` |
| `fs.read` | `{workloadId, path, maxBytes (≤ 5 MiB)}` | `{content, encoding: "utf8"\|"base64", sha256, size, truncated}` |
| `fs.write` | `{workloadId, path, content, encoding, ifMatchSha256: string\|null\|undefined, createParents}` — `null` = must not exist; temp file + fsync + rename | `{sha256, size}` |
| `fs.mkdir` | `{workloadId, path}` | `{}` |
| `fs.rename` | `{workloadId, from, to}` | `{}` |
| `fs.delete` | `{workloadId, path, recursive}` | `{}` |
| `fs.du` | `{workloadId, path, depth (≤3), top (≤50)}` | `{totalBytes, children: [{path, bytes}], largestFiles: [{path, bytes}]}` |
| `fs.extract` | `{workloadId, archivePath, destPath, maxTotalBytes, maxEntries}` — zip/tar/tar.gz; rejects symlinks, hardlinks, absolute paths, `..`, devices | `{entries, bytes}` |
| `fs.transfer.push` | `{workloadId, path, transferId}` — agent streams file to `POST /agent/v1/transfers/:id` | `{bytes, sha256}` |
| `fs.transfer.pull` | `{workloadId, path, transferId, maxBytes}` — agent streams from `GET /agent/v1/transfers/:id` into temp file then renames | `{bytes, sha256}` |
| `artifact.fetch` | `{workloadId, url, destPath, checksum: {algorithm: "sha1"\|"sha256"\|"sha512", value} \| null, maxBytes}` — HTTPS only, host must be on the agent's allowlist, no redirects to non-allowlisted hosts | `{bytes, sha256}` |
| `backup.create` | Phase 6 | |
| `backup.restore` | Phase 6 | |
| `credentials.rotate` | `{}` — staged rotation, see §3.1 | `{publicKey, proof}` |

`WorkloadSpec` (see `packages/contracts/src/agent/workload.ts`):

```ts
{ workloadId, kind: "minecraft" | "velocity",
  image: string,                 // must match agent image allowlist (default: eclipse-temurin:*)
  command: string[],             // argv, no shell; e.g. ["java","-Xms1G","-Xmx4G","-jar","server.jar","nogui"]
  env: Record<string,string>,    // keys must match ^[A-Z][A-Z0-9_]{0,63}$
  memoryLimitBytes, cpuLimitMillicores, pidsLimit,
  ports: [{ containerPort, hostPort, hostIp, protocol: "tcp"|"udp" }],
  networks: [{ name, aliases }], // agent creates bridge networks named bf-* on demand
  stopCommand: "stop" | "end" | null, stopTimeoutMs,
  restartPolicy: { mode: "never"|"on-failure"|"always", maxRetries, backoffMs },
  jvmProbe: boolean, labels: Record<string,string> }
```

**Image authorisation** is enforced by the agent, never by schema validation: the image must
match an entry of the agent's own `imageAllowlist` (config file, default `eclipse-temurin:*`).
Matching: an entry `repo:*` matches any tag (not digest) of exactly `repo`; an entry without
`*` must match the full reference exactly; Docker Hub short names are normalised
(`eclipse-temurin` ≡ `docker.io/library/eclipse-temurin`). Registries with ports are not
supported in v1.

**Command history redaction.** `COMMAND_REDACTIONS` lists payload fields that can carry
secrets (`fs.write.content`, `workload.ensure.env`, `artifact.fetch.url` query/fragment).
`redactCommandPayload()` is applied before anything is persisted (`agent_commands`, job input,
audit details) or logged.

Container hardening applied by the agent regardless of spec: run as UID/GID 1000 (or the
configured unprivileged ID), `no-new-privileges`, drop all capabilities, read-only image
root filesystem with tmpfs `/tmp`, data root bind-mounted read-write at `/data`, working dir
`/data`, `pids-limit`, no privileged mode, no host networking, no Docker socket mounts.

`WorkloadStatus`: `{workloadId, exists, state: "created"|"running"|"restarting"|"exited"|"dead"|"missing", exitCode?, oomKilled?, startedAt?, finishedAt?, restartCount, image, containerId?}`.

## 7. Telemetry samples

See `packages/contracts/src/agent/metrics.ts`. Node sample: CPU (total, per core,
load averages, iowait/steal where supported), memory (total/used/available/cached/buffers/
swap), filesystems (per mount usage + inodes), disk I/O per device (bytes/s, ops/s, busy %,
average latency ms where computable), network per interface (bytes/s, packets/s, cumulative
errors/drops), TCP connection counts. Workload sample: container CPU %, throttled periods,
memory usage/limit/cache, network rx/tx bytes/s (attributable because each workload has its
own network namespace), block I/O bytes/s, pids, optional JVM stats (from the JVM probe:
heap used/committed/max, non-heap, GC count/time, threads, process uptime) and optional
Minecraft SLP status (players online/max/sample, version, latency).

Fields that a platform cannot provide are **omitted** (never zero-filled) so the UI can
render "not available" instead of a misleading value.
