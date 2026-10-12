// Regenerates the golden agent-protocol fixtures shared by the TS and Go test suites.
// Deterministic: fixed test-only keys, fixed timestamps and IDs. Run: node scripts/gen-fixtures.mjs
import { createPrivateKey, createPublicKey, sign } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const out = join(dirname(fileURLToPath(import.meta.url)), "..", "fixtures", "agent");
mkdirSync(out, { recursive: true });

const b64u = (buf) => Buffer.from(buf).toString("base64url");
// PKCS#8 DER prefix for a raw 32-byte Ed25519 seed.
const ED25519_PKCS8_PREFIX = Buffer.from("302e020100300506032b657004220420", "hex");

function keyFromSeed(seedHex) {
  const priv = createPrivateKey({
    key: Buffer.concat([ED25519_PKCS8_PREFIX, Buffer.from(seedHex, "hex")]),
    format: "der",
    type: "pkcs8",
  });
  const rawPub = createPublicKey(priv).export({ format: "der", type: "spki" }).subarray(-32);
  return { priv, seed: seedHex, publicKey: b64u(rawPub) };
}

// TEST-ONLY KEYS. Never use outside fixtures.
const cp = keyFromSeed("0101010101010101010101010101010101010101010101010101010101010101");
const agent = keyFromSeed("0202020202020202020202020202020202020202020202020202020202020202");

const NODE_ID = "6f1c2b9a-4d3e-4f5a-9b8c-7d6e5f4a3b2c";
const WORKLOAD_ID = "1a2b3c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d";
const T0 = 1760000000000;

const write = (name, value) => writeFileSync(join(out, name), JSON.stringify(value, null, 2) + "\n");

write("keys.json", {
  _comment: "TEST-ONLY Ed25519 keys (seed hex, public key base64url). Never use in production.",
  controlPlane: { seedHex: cp.seed, publicKey: cp.publicKey },
  agent: { seedHex: agent.seed, publicKey: agent.publicKey },
  nodeId: NODE_ID,
  workloadId: WORKLOAD_ID,
  now: T0,
});

const facts = {
  hostname: "mc-node-1",
  os: "linux",
  platform: "ubuntu",
  platformVersion: "24.04",
  kernelVersion: "6.8.0-45-generic",
  arch: "amd64",
  cpuModel: "AMD EPYC 7543P 32-Core Processor",
  cpuPhysicalCores: 32,
  cpuLogicalCores: 64,
  memoryTotalBytes: 137438953472,
  swapTotalBytes: 8589934592,
  bootTime: 1759000000000,
  timezone: "UTC",
  dataRoot: "/var/lib/blockforge",
  interfaces: [{ name: "eth0", mac: "02:42:ac:11:00:02", mtu: 1500, addresses: ["10.0.0.11/24"], up: true }],
  filesystems: [{ mount: "/", device: "/dev/nvme0n1p2", fsType: "ext4", totalBytes: 1000204886016 }],
  containerRuntime: {
    name: "docker",
    version: "29.8.2",
    apiVersion: "1.52",
    rootless: false,
    cgroupVersion: "2",
    storageDriver: "overlay2",
    healthy: true,
  },
  javaRuntimes: [{ major: 21, version: "21.0.8+9", vendor: "Eclipse Adoptium", source: "image", ref: "eclipse-temurin:21-jre" }],
};

write("enroll-request.json", {
  token: "bfe_0123456789abcdef_" + b64u(Buffer.alloc(32, 7)),
  publicKey: agent.publicKey,
  agentVersion: "0.1.0",
  protocolVersion: 1,
  facts,
  nodeName: "mc-node-1",
});
write("enroll-response.json", {
  nodeId: NODE_ID,
  approved: true,
  controlPlaneSigningKey: cp.publicKey,
  heartbeatIntervalMs: 15000,
  metricsIntervalMs: 5000,
});

// Agent auth token
const claims = { nid: NODE_ID, aud: "blockforge-control-plane", iat: T0, exp: T0 + 60000, jti: "dGVzdC1qdGktMDAwMDAwMQ" };
const claimsSeg = b64u(JSON.stringify(claims));
const tokenSig = b64u(sign(null, Buffer.from(claimsSeg, "ascii"), agent.priv));
write("auth-token.json", { header: `BFAgent ${claimsSeg}.${tokenSig}`, claims, signerPublicKey: agent.publicKey });

// Signed commands
function cmd(id, type, payload, { expiresIn = 300000, nodeId = NODE_ID, key = cp.priv } = {}) {
  const body = JSON.stringify({ id, nodeId, type, issuedAt: T0, expiresAt: T0 + expiresIn, payload });
  return { t: "cmd", body, sig: b64u(sign(null, Buffer.from(body, "utf8"), key)) };
}

write("cmd-workload-start.json", cmd("00000000-0000-4000-8000-000000000001", "workload.start", { workloadId: WORKLOAD_ID }));
write(
  "cmd-workload-ensure.json",
  cmd("00000000-0000-4000-8000-000000000002", "workload.ensure", {
    workloadId: WORKLOAD_ID,
    kind: "minecraft",
    image: "eclipse-temurin:21-jre",
    command: ["java", "-Xms1024M", "-Xmx3276M", "-jar", "server.jar", "nogui"],
    env: { TZ: "UTC" },
    memoryLimitBytes: 4294967296,
    cpuLimitMillicores: 2000,
    pidsLimit: 4096,
    ports: [{ containerPort: 25565, hostPort: 25565, hostIp: "0.0.0.0", protocol: "tcp" }],
    networks: [{ name: "bf-net-main", aliases: ["lobby"] }],
    stopCommand: "stop",
    stopTimeoutMs: 60000,
    restartPolicy: { mode: "on-failure", maxRetries: 3, backoffMs: 10000 },
    jvmProbe: true,
    labels: { "io.blockforge.server-slug": "lobby" },
  }),
);
write(
  "cmd-fs-write.json",
  cmd("00000000-0000-4000-8000-000000000003", "fs.write", {
    workloadId: WORKLOAD_ID,
    path: "server.properties",
    content: "motd=Hello \\u00a7aWorld\nmax-players=20\n",
    encoding: "utf8",
    ifMatchSha256: null,
    createParents: false,
  }),
);
write(
  "cmd-artifact-fetch.json",
  cmd("00000000-0000-4000-8000-000000000004", "artifact.fetch", {
    workloadId: WORKLOAD_ID,
    url: "https://fill-data.papermc.io/v1/objects/abc/paper-1.21.8-60.jar",
    destPath: "server.jar",
    checksum: { algorithm: "sha256", value: "a".repeat(64) },
    maxBytes: 268435456,
  }),
);
// Rejection cases
const tampered = cmd("00000000-0000-4000-8000-000000000005", "workload.kill", { workloadId: WORKLOAD_ID });
tampered.body = tampered.body.replace("workload.kill", "workload.stop");
write("cmd-reject-bad-signature.json", tampered);
write(
  "cmd-reject-wrong-node.json",
  cmd("00000000-0000-4000-8000-000000000006", "workload.kill", { workloadId: WORKLOAD_ID }, { nodeId: "99999999-9999-4999-8999-999999999999" }),
);
write(
  "cmd-reject-wrong-key.json",
  cmd("00000000-0000-4000-8000-000000000007", "workload.kill", { workloadId: WORKLOAD_ID }, { key: agent.priv }),
);
write(
  "cmd-reject-lifetime.json",
  cmd("00000000-0000-4000-8000-000000000008", "workload.kill", { workloadId: WORKLOAD_ID }, { expiresIn: 3600000 }),
);

// issuedAt after expiresAt (negative lifetime) must be rejected even though expiry is in the future.
{
  const body = JSON.stringify({
    id: "00000000-0000-4000-8000-00000000000b",
    nodeId: NODE_ID,
    type: "workload.kill",
    issuedAt: T0 + 3_600_000,
    expiresAt: T0 + 60_000,
    payload: { workloadId: WORKLOAD_ID },
  });
  write("cmd-reject-reversed-timestamps.json", { t: "cmd", body, sig: b64u(sign(null, Buffer.from(body, "utf8"), cp.priv)) });
}

// Signature and node are valid, but the payload targets the data root → payload validation must reject it.
write(
  "cmd-reject-root-delete.json",
  cmd("00000000-0000-4000-8000-000000000009", "fs.delete", { workloadId: WORKLOAD_ID, path: "./", recursive: true }),
);

// Staged credential rotation: the agent proves possession of the next key.
const nextAgent = keyFromSeed("0303030303030303030303030303030303030303030303030303030303030303");
const ROTATE_CMD_ID = "00000000-0000-4000-8000-00000000000a";
write("cmd-credentials-rotate.json", cmd(ROTATE_CMD_ID, "credentials.rotate", {}));
write("result-credentials-rotate.json", {
  t: "result",
  id: ROTATE_CMD_ID,
  ts: T0,
  ok: true,
  data: {
    publicKey: nextAgent.publicKey,
    proof: b64u(sign(null, Buffer.from(`blockforge-rotate:${NODE_ID}:${ROTATE_CMD_ID}`, "utf8"), nextAgent.priv)),
  },
});

write("welcome.json", { t: "welcome", nodeId: NODE_ID, serverTime: T0, approved: true, heartbeatIntervalMs: 15000, metricsIntervalMs: 5000 });

const status = {
  workloadId: WORKLOAD_ID,
  exists: true,
  state: "running",
  startedAt: T0 - 3600000,
  restartCount: 0,
  image: "eclipse-temurin:21-jre",
  containerId: "3f4e5d6c7b8a",
  specHash: "sha256:" + "b".repeat(64),
};
write("hello.json", { t: "hello", agentVersion: "0.1.0", protocolVersion: 1, ts: T0, facts, capabilities: ["docker", "jvm-probe", "slp"], workloads: [status] });
write("heartbeat.json", { t: "heartbeat", ts: T0, uptimeMs: 86400000 });
write("progress.json", { t: "progress", id: "00000000-0000-4000-8000-000000000004", ts: T0, stage: "download", message: "42 MiB of 48 MiB", percent: 87.5 });
write("result-ok.json", { t: "result", id: "00000000-0000-4000-8000-000000000001", ts: T0, ok: true, data: status });
write("result-error.json", {
  t: "result",
  id: "00000000-0000-4000-8000-000000000003",
  ts: T0,
  ok: false,
  error: { code: "CONFLICT", message: "file changed since it was read", retryable: false, details: { currentSha256: "c".repeat(64) } },
});
write("event-workload-state.json", { t: "event", ts: T0, event: "workload.state", data: { ...status, state: "exited", exitCode: 137, oomKilled: true, finishedAt: T0 } });
write("logs.json", {
  t: "logs",
  workloadId: WORKLOAD_ID,
  lines: [
    { ts: T0, stream: "stdout", line: "[12:00:00 INFO]: Done (4.211s)! For help, type \"help\"" },
    { ts: T0 + 5, stream: "stdout", line: "[12:00:05 INFO]: Steve joined the game" },
    { ts: T0 + 9, stream: "stderr", line: "<script>alert(1)</script> \u001b[31mred\u001b[0m" },
  ],
  dropped: 0,
});
write("metrics.json", {
  t: "metrics",
  ts: T0,
  node: {
    ts: T0,
    cpu: { usagePct: 37.5, perCorePct: [40.1, 35.2, 38.0, 36.7], load1: 2.1, load5: 1.9, load15: 1.7, iowaitPct: 0.4, stealPct: 0 },
    memory: {
      totalBytes: 137438953472,
      usedBytes: 41231686041,
      availableBytes: 96207267431,
      cachedBytes: 20000000000,
      buffersBytes: 1000000000,
      swapTotalBytes: 8589934592,
      swapUsedBytes: 0,
    },
    filesystems: [
      { mount: "/", device: "/dev/nvme0n1p2", fsType: "ext4", totalBytes: 1000204886016, usedBytes: 250051221504, freeBytes: 750153664512, inodesTotal: 61054976, inodesUsed: 812345 },
    ],
    diskIo: [{ device: "nvme0n1", readBytesPerSec: 1048576, writeBytesPerSec: 4194304, readOpsPerSec: 120, writeOpsPerSec: 340, busyPct: 3.2, avgLatencyMs: 0.21 }],
    network: [
      { iface: "eth0", rxBytesPerSec: 1250000, txBytesPerSec: 3400000, rxPacketsPerSec: 2100, txPacketsPerSec: 3900, rxErrorsTotal: 0, txErrorsTotal: 0, rxDroppedTotal: 12, txDroppedTotal: 0 },
    ],
    tcp: { established: 184, total: 260 },
  },
  workloads: [
    {
      workloadId: WORKLOAD_ID,
      ts: T0,
      running: true,
      cpuPct: 142.5,
      cpuThrottledPeriodsTotal: 17,
      memoryUsageBytes: 2684354560,
      memoryLimitBytes: 4294967296,
      memoryCacheBytes: 104857600,
      netRxBytesPerSec: 51200,
      netTxBytesPerSec: 204800,
      blkReadBytesPerSec: 0,
      blkWriteBytesPerSec: 65536,
      pids: 61,
      diskUsageBytes: 1610612736,
      jvm: { heapUsedBytes: 1503238553, heapCommittedBytes: 2147483648, heapMaxBytes: 3435973836, nonHeapUsedBytes: 201326592, gcCountTotal: 412, gcTimeMsTotal: 5230, threads: 58, uptimeMs: 3590000, sampledAt: T0 - 2000 },
      minecraft: { versionName: "Paper 1.21.8", protocol: 772, playersOnline: 2, playersMax: 20, playerSample: [{ name: "Steve", id: "8667ba71-b85a-4004-af54-457a9734eed7" }], motd: "A BlockForge server", latencyMs: 1.8 },
    },
  ],
});
console.log("fixtures written to", out);
