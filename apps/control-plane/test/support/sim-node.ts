import { createHash } from "node:crypto";
import type { CommandBody, FileEntry, NodeMetricSample, WorkloadMetricSample, WorkloadSpec, WorkloadStatus } from "@blockforge/contracts";
import type { AgentCommandType } from "@blockforge/contracts";
import { loadFixture, type FakeAgent } from "./fake-agent.js";

type Entry = { type: "file" | "dir"; data: Buffer; mode: number; mtime: number };

interface SimWorkload {
  spec: WorkloadSpec;
  state: WorkloadStatus["state"];
  exitCode?: number;
  startedAt?: number;
  finishedAt?: number;
  restartCount: number;
  oomKilled?: boolean;
}

export interface SimOptions {
  /** Console line emitted (stdout) shortly after `workload.start`; null = none. */
  readyLine?: string | null;
  /** Exit code reported right after `workload.start` (crash during start-up). */
  crashOnStart?: number | null;
  /** The start-up exit is an OOM kill. */
  oomOnStart?: boolean;
  /** Console lines (stdout) printed after `workload.start`, before the ready line or the exit. */
  startupLines?: string[];
  /** After the ready line, send a workload metrics sample with Server List Ping status (contracts fixture). */
  slpAfterReady?: boolean;
  installExitCode?: number;
  /** Files the install container "creates" (path → content). */
  installCreates?: Record<string, string>;
  /** Output of the install container (streamed as `logs` frames with `source: "install"`). */
  installLines?: string[];
  ports?: { tcp: number[]; udp: number[] };
  /** Commands that fail with this error. */
  fail?: Partial<Record<AgentCommandType, { code: string; message: string; retryable?: boolean }>>;
  /** Delay before answering a command type (ms). */
  delay?: Partial<Record<AgentCommandType, number>>;
}

class SimError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

export const DEFAULT_READY_LINE = '[12:00:00 INFO]: Done (3.141s)! For help, type "help"';
const sha = (b: Buffer) => createHash("sha256").update(b).digest("hex");
const norm = (p: string) => p.split(/[\\/]+/).filter((s) => s && s !== ".").join("/");
const parentOf = (p: string) => (p.includes("/") ? p.slice(0, p.lastIndexOf("/")) : "");
const nameOf = (p: string) => p.slice(p.lastIndexOf("/") + 1);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Mirrors the Go agent's `copyName`/`splitExt` ("name copy.ext", "name copy 2.ext"). */
function copyName(base: string, n: number, isDir: boolean): string {
  let name = base;
  let ext = "";
  if (!isDir) {
    const multi = [".tar.gz", ".tar.xz", ".tar.bz2", ".tar.zst"].find((e) => base.toLowerCase().endsWith(e) && base.length > e.length);
    if (multi) {
      name = base.slice(0, base.length - multi.length);
      ext = base.slice(base.length - multi.length);
    } else {
      const i = base.lastIndexOf(".");
      if (i > 0) {
        name = base.slice(0, i);
        ext = base.slice(i);
      }
    }
  }
  return n === 1 ? `${name} copy${ext}` : `${name} copy ${n}${ext}`;
}

/**
 * An in-memory node behind a {@link FakeAgent}: answers the Phase 3 command catalogue with the Go
 * agent's result shapes (workload lifecycle, install containers with `source: "install"` logs,
 * artifact downloads, sandboxed `fs.*`, transfers over the rendezvous, `node.ports`), and emits
 * console/readiness lines and `workload.state` events like the real agent.
 */
export class SimNode {
  readonly fs = new Map<string, Map<string, Entry>>();
  readonly workloads = new Map<string, SimWorkload>();
  readonly installs: CommandBody[] = [];
  readonly consoleLines: { workloadId: string; line: string }[] = [];
  readonly fetched: { workloadId: string; url: string; destPath: string }[] = [];
  readonly ensured: WorkloadSpec[] = [];

  constructor(
    readonly agent: FakeAgent,
    public options: SimOptions = {},
  ) {
    const on = <T extends AgentCommandType>(type: T, fn: (p: Record<string, unknown>, body: CommandBody) => unknown) =>
      agent.onCommandType(type, async (body) => {
        const delay = this.options.delay?.[type];
        if (delay) await sleep(delay);
        const f = this.options.fail?.[type];
        if (f) return { ok: false, error: { retryable: false, ...f } };
        try {
          return { ok: true, data: await fn(body.payload as Record<string, unknown>, body) };
        } catch (err) {
          if (err instanceof SimError) return { ok: false, error: { code: err.code, message: err.message } };
          throw err;
        }
      });

    on("node.ports", () => this.options.ports ?? { tcp: [], udp: [] });

    on("workload.ensure", (p) => {
      const spec = p as unknown as WorkloadSpec;
      this.ensured.push(spec);
      const existing = this.workloads.get(spec.workloadId);
      const changed = Boolean(existing) && JSON.stringify(existing!.spec) !== JSON.stringify(spec);
      if (existing) existing.spec = spec;
      else this.workloads.set(spec.workloadId, { spec, state: "created", restartCount: 0 });
      this.files(spec.workloadId);
      return { created: !existing, changed, status: this.status(spec.workloadId) };
    });

    on("workload.install", async (p, body) => {
      this.installs.push(body);
      const id = String(p.workloadId);
      const ts = Date.now();
      const lines = this.options.installLines ?? ["installing", "done"];
      this.agent.send({ t: "logs", workloadId: id, source: "install", lines: lines.map((line) => ({ ts, stream: "stdout", line })) });
      for (const [path, content] of Object.entries(this.options.installCreates ?? {})) this.put(id, path, content);
      await sleep(20);
      return { exitCode: this.options.installExitCode ?? 0, durationMs: 1234, timedOut: false, logTail: lines };
    });

    on("artifact.fetch", (p) => {
      const id = String(p.workloadId);
      this.fetched.push({ workloadId: id, url: String(p.url), destPath: String(p.destPath) });
      const data = Buffer.from(`artifact:${String(p.url)}`);
      this.put(id, String(p.destPath), data);
      return { bytes: data.length, sha256: sha(data), cached: false };
    });

    on("workload.start", (p) => {
      const id = String(p.workloadId);
      const w = this.workloads.get(id);
      if (!w) throw new SimError("NOT_FOUND", "workload does not exist");
      w.state = "running";
      w.startedAt = Date.now();
      delete w.exitCode;
      delete w.oomKilled;
      const crash = this.options.crashOnStart;
      const ready = this.options.readyLine === undefined ? DEFAULT_READY_LINE : this.options.readyLine;
      const startup = this.options.startupLines ?? [];
      setTimeout(() => {
        if (startup.length) this.agent.logs(id, startup.map((line) => ({ ts: Date.now(), stream: "stdout" as const, line })));
        if (crash !== null && crash !== undefined) {
          this.exit(id, crash, true, this.options.oomOnStart ?? false);
        } else if (ready) {
          this.agent.logs(id, [{ ts: Date.now(), stream: "stdout", line: ready }]);
          if (this.options.slpAfterReady) this.sendSlp(id);
        }
      }, 30);
      return this.status(id);
    });

    on("workload.stop", (p) => {
      const id = String(p.workloadId);
      if (!this.workloads.has(id)) throw new SimError("NOT_FOUND", "workload does not exist");
      return this.exit(id, 0, false);
    });

    on("workload.kill", (p) => {
      const id = String(p.workloadId);
      if (!this.workloads.has(id)) throw new SimError("NOT_FOUND", "workload does not exist");
      return this.exit(id, 137, false);
    });

    on("workload.remove", (p) => {
      const id = String(p.workloadId);
      this.workloads.delete(id);
      if (p.deleteData) this.fs.delete(id);
      return {};
    });

    on("workload.status", (p) => {
      const ids = p.workloadId ? [String(p.workloadId)] : [...this.workloads.keys()];
      return { workloads: ids.map((id) => this.status(id)) };
    });

    on("workload.console", (p) => {
      this.consoleLines.push({ workloadId: String(p.workloadId), line: String(p.line) });
      return {};
    });

    // --- fs.* ------------------------------------------------------------------------------
    on("fs.list", (p) => {
      const dir = norm(String(p.path));
      const files = this.files(String(p.workloadId));
      if (dir && files.get(dir)?.type !== "dir") throw new SimError("NOT_FOUND", "no such directory");
      const entries = [...files].filter(([path]) => parentOf(path) === dir).map(([path, e]) => this.entry(path, e));
      return { entries, truncated: false };
    });
    on("fs.stat", (p) => {
      const path = norm(String(p.path));
      const e = this.files(String(p.workloadId)).get(path);
      if (!e) throw new SimError("NOT_FOUND", "no such file");
      return this.entry(path, e);
    });
    on("fs.read", (p) => {
      const e = this.files(String(p.workloadId)).get(norm(String(p.path)));
      if (!e || e.type !== "file") throw new SimError("NOT_FOUND", "no such file");
      const max = Number(p.maxBytes);
      const slice = e.data.subarray(0, max);
      const text = slice.toString("utf8");
      const utf8 = Buffer.from(text, "utf8").equals(slice);
      return { content: utf8 ? text : slice.toString("base64"), encoding: utf8 ? "utf8" : "base64", sha256: sha(e.data), size: e.data.length, truncated: e.data.length > max };
    });
    on("fs.write", (p) => {
      const id = String(p.workloadId);
      const path = norm(String(p.path));
      const cur = this.files(id).get(path);
      if (p.ifMatchSha256 === null && cur) throw new SimError("CONFLICT", "file already exists");
      if (typeof p.ifMatchSha256 === "string" && (!cur || sha(cur.data) !== p.ifMatchSha256)) throw new SimError("CONFLICT", "file changed since it was read");
      if (!p.createParents && parentOf(path) && this.files(id).get(parentOf(path))?.type !== "dir") throw new SimError("NOT_FOUND", "parent directory does not exist");
      const data = Buffer.from(String(p.content), p.encoding === "base64" ? "base64" : "utf8");
      this.put(id, path, data);
      return { sha256: sha(data), size: data.length };
    });
    on("fs.mkdir", (p) => {
      const id = String(p.workloadId);
      const path = norm(String(p.path));
      if (this.files(id).has(path)) throw new SimError("CONFLICT", "already exists");
      this.mkdirs(id, path);
      return {};
    });
    on("fs.rename", (p) => {
      const id = String(p.workloadId);
      const from = norm(String(p.from));
      const to = norm(String(p.to));
      const files = this.files(id);
      if (!files.has(from)) throw new SimError("NOT_FOUND", "no such file");
      if (files.has(to)) throw new SimError("CONFLICT", "destination exists");
      for (const [path, e] of [...files]) {
        if (path === from || path.startsWith(`${from}/`)) {
          files.delete(path);
          files.set(to + path.slice(from.length), e);
        }
      }
      return {};
    });
    on("fs.delete", (p) => {
      const id = String(p.workloadId);
      const path = norm(String(p.path));
      const files = this.files(id);
      if (!files.has(path)) throw new SimError("NOT_FOUND", "no such file");
      const children = [...files.keys()].filter((k) => k.startsWith(`${path}/`));
      if (children.length && !p.recursive) throw new SimError("CONFLICT", "directory not empty");
      for (const k of [path, ...children]) files.delete(k);
      return {};
    });
    on("fs.copy", (p) => {
      const id = String(p.workloadId);
      const src = norm(String(p.path));
      const files = this.files(id);
      const e = files.get(src);
      if (!e) throw new SimError("NOT_FOUND", "no such file");
      const candidate = (n: number) => [parentOf(src), copyName(nameOf(src), n, e.type === "dir")].filter(Boolean).join("/");
      let n = 1;
      while (files.has(candidate(n))) n++;
      const dest = candidate(n);
      for (const [path, entry] of [...files]) {
        if (path === src || path.startsWith(`${src}/`)) files.set(dest + path.slice(src.length), { ...entry, data: Buffer.from(entry.data) });
      }
      return { path: dest };
    });
    on("fs.chmod", (p) => {
      const e = this.files(String(p.workloadId)).get(norm(String(p.path)));
      if (!e) throw new SimError("NOT_FOUND", "no such file");
      e.mode = Number(p.mode);
      return {};
    });
    on("fs.find", (p) => {
      const base = norm(String(p.path));
      const q = String(p.query).toLowerCase();
      const max = Number(p.maxResults ?? 100);
      const all = [...this.files(String(p.workloadId))].filter(([path]) => (!base || path.startsWith(`${base}/`)) && nameOf(path).toLowerCase().includes(q));
      return { matches: all.slice(0, max).map(([path, e]) => this.entry(path, e)), truncated: all.length > max };
    });
    on("fs.compress", (p) => {
      const id = String(p.workloadId);
      const root = norm(String(p.root));
      const files = this.files(id);
      const sources = (p.paths as string[]).map((x) => [root, norm(x)].filter(Boolean).join("/"));
      let entries = 0;
      for (const s of sources) {
        if (!files.has(s)) throw new SimError("NOT_FOUND", `${s} does not exist`);
        entries += [...files.keys()].filter((k) => k === s || k.startsWith(`${s}/`)).length;
      }
      const ext = p.format === "zip" ? ".zip" : ".tar.gz";
      const dest = p.destPath ? norm(String(p.destPath)) : [root, `archive-${new Date().toISOString().replace(/[-:]/g, "").slice(0, 15)}Z${ext}`].filter(Boolean).join("/");
      if (files.has(dest)) throw new SimError("CONFLICT", "archive exists");
      const data = Buffer.from(`archive of ${sources.join(",")}`);
      this.put(id, dest, data);
      return { path: dest, size: data.length, entries };
    });
    on("fs.extract", (p) => {
      const id = String(p.workloadId);
      const archive = norm(String(p.archivePath));
      if (this.files(id).get(archive)?.type !== "file") throw new SimError("NOT_FOUND", "no such archive");
      const data = Buffer.from("extracted");
      this.put(id, [norm(String(p.destPath)), "extracted.txt"].filter(Boolean).join("/"), data);
      return { entries: 1, bytes: data.length };
    });
    on("fs.transfer.pull", async (p) => {
      const res = await this.agent.download(String(p.transferId));
      if (res.status !== 200) throw new SimError("TRANSFER_FAILED", `rendezvous answered ${res.status}`);
      const data = Buffer.from(await res.arrayBuffer());
      if (data.length > Number(p.maxBytes)) throw new SimError("QUOTA_EXCEEDED", "transfer larger than announced");
      this.put(String(p.workloadId), String(p.path), data);
      return { bytes: data.length, sha256: sha(data) };
    });
    on("fs.transfer.push", async (p) => {
      const e = this.files(String(p.workloadId)).get(norm(String(p.path)));
      if (!e || e.type !== "file") throw new SimError("NOT_FOUND", "no such file");
      const up = await this.agent.upload(String(p.transferId), e.data);
      if (up.status !== 200) throw new SimError("TRANSFER_FAILED", `rendezvous answered ${up.status}`);
      return { bytes: e.data.length, sha256: sha(e.data) };
    });
  }

  files(workloadId: string): Map<string, Entry> {
    let m = this.fs.get(workloadId);
    if (!m) this.fs.set(workloadId, (m = new Map()));
    return m;
  }

  private mkdirs(workloadId: string, path: string): void {
    const parts = norm(path).split("/").filter(Boolean);
    for (let i = 1; i <= parts.length; i++) {
      const p = parts.slice(0, i).join("/");
      if (!this.files(workloadId).has(p)) this.files(workloadId).set(p, { type: "dir", data: Buffer.alloc(0), mode: 0o755, mtime: Date.now() });
    }
  }

  /** Writes a file (creating parent directories). */
  put(workloadId: string, path: string, content: string | Buffer): void {
    const p = norm(path);
    if (parentOf(p)) this.mkdirs(workloadId, parentOf(p));
    this.files(workloadId).set(p, { type: "file", data: Buffer.isBuffer(content) ? content : Buffer.from(content), mode: 0o644, mtime: Date.now() });
  }

  read(workloadId: string, path: string): string | null {
    return this.files(workloadId).get(norm(path))?.data.toString("utf8") ?? null;
  }

  private entry(path: string, e: Entry): FileEntry {
    return { name: nameOf(path), path, type: e.type, size: e.data.length, modifiedAt: e.mtime, mode: e.mode.toString(8).padStart(4, "0") };
  }

  status(workloadId: string): WorkloadStatus {
    const w = this.workloads.get(workloadId);
    if (!w) return { workloadId, exists: false, state: "missing", restartCount: 0 };
    return {
      workloadId,
      exists: true,
      state: w.state,
      restartCount: w.restartCount,
      image: w.spec.image,
      ...(w.oomKilled ? { oomKilled: true } : {}),
      ...(w.exitCode !== undefined ? { exitCode: w.exitCode } : {}),
      ...(w.startedAt !== undefined ? { startedAt: w.startedAt } : {}),
      ...(w.finishedAt !== undefined ? { finishedAt: w.finishedAt } : {}),
    };
  }

  /** The workload exits (optionally reported as a `workload.state` event, as the agent's Docker watcher does). */
  exit(workloadId: string, exitCode: number, emit = true, oomKilled = false): WorkloadStatus {
    const w = this.workloads.get(workloadId);
    if (w) {
      w.state = "exited";
      w.exitCode = exitCode;
      w.oomKilled = oomKilled;
      w.finishedAt = Date.now();
    }
    const st = this.status(workloadId);
    if (emit) this.agent.send({ t: "event", ts: Date.now(), event: "workload.state", data: st });
    return st;
  }

  /** A metrics frame whose workload sample carries SLP status (the agent's game probe). */
  sendSlp(workloadId: string): void {
    const frame = loadFixture<{ node: NodeMetricSample; workloads: WorkloadMetricSample[] }>("metrics.json");
    const ts = Date.now();
    this.agent.metrics({ ...frame.node, ts }, [{ ...frame.workloads[0]!, workloadId, ts }]);
  }

  /** Emits a `workload.state` event for the current status. */
  emitState(workloadId: string): void {
    this.agent.send({ t: "event", ts: Date.now(), event: "workload.state", data: this.status(workloadId) });
  }
}
