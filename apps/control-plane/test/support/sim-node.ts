import { createHash } from "node:crypto";
import type { CommandBody, FileEntry, NodeMetricSample, WorkloadMetricSample, WorkloadSpec, WorkloadStatus } from "@blockforge/contracts";
import { compileDenylist, type AgentCommandType } from "@blockforge/contracts";
import { loadFixture, type FakeAgent } from "./fake-agent.js";

type Entry = { type: "file" | "dir" | "symlink"; data: Buffer; mode: number; mtime: number; target?: string };

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
  /** Answer `save-all flush` with "Saved the game" (default true). */
  saveConfirm?: boolean;
  /** Answer `save-all flush` with the disk-full failure instead. */
  saveFailure?: boolean;
  /** Raw console lines printed right after `save-all flush`, before the server's progress line (forged / stray confirmations). */
  saveStrayLines?: string[];
  /** Acknowledge `save-off` / `save-on` (default true). */
  saveOffConfirm?: boolean;
  saveOnConfirm?: boolean;
  /** The workload exits (crash) while it is being archived (no event: only `workload.status` shows it). */
  exitDuringBackup?: boolean;
  /** Offset of the agent's clock in console line timestamps (clock skew between node and control plane). */
  clockSkewMs?: number;
  /** What `workload.logs.tail` returns (the agent's ring buffer / Docker logs). */
  logTail?: string[];
}

/** A local backup archive as the sim stores it (content = JSON of the archived files). */
export interface SimArchive {
  bytes: Buffer;
  sha256: string;
  files: Record<string, string>;
}

class SimError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly details?: Record<string, unknown>,
  ) {
    super(message);
  }
}

const denied = (path: string) => new SimError("PATH_FORBIDDEN", `${path || "/"} is denied`, { reason: "denylist" });

export const DEFAULT_READY_LINE = '[12:00:00 INFO]: Done (3.141s)! For help, type "help"';
const sha = (b: Buffer) => createHash("sha256").update(b).digest("hex");
const norm = (p: string) => p.split(/[\\/]+/).filter((s) => s && s !== ".").join("/");
const parentOf = (p: string) => (p.includes("/") ? p.slice(0, p.lastIndexOf("/")) : "");
const nameOf = (p: string) => p.slice(p.lastIndexOf("/") + 1);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Joins a relative symlink target to its directory, refusing absolute targets and escapes. */
function joinInside(dir: string, target: string): string {
  if (target.startsWith("/")) throw new SimError("PATH_FORBIDDEN", "symlink escapes the data root");
  const out = dir ? dir.split("/") : [];
  for (const seg of target.split("/")) {
    if (!seg || seg === ".") continue;
    if (seg === "..") {
      if (!out.length) throw new SimError("PATH_FORBIDDEN", "symlink escapes the data root");
      out.pop();
    } else out.push(seg);
  }
  return out.join("/");
}

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
  /** `denylist` of every fs command as received (undefined = none sent). */
  readonly denylists: { type: string; denylist: string[] | undefined }[] = [];
  /** Archive contents (`<workloadId>:<path>` → entry → content) created by fs.compress or planted by tests. */
  readonly archives = new Map<string, Record<string, string>>();
  /** Local backup archives (`<workloadId>:<backupId>`). */
  readonly backupArchives = new Map<string, SimArchive>();

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
        const payload = body.payload as Record<string, unknown>;
        if (type.startsWith("fs.")) this.denylists.push({ type, denylist: payload.denylist as string[] | undefined });
        try {
          return { ok: true, data: await fn(payload, body) };
        } catch (err) {
          if (err instanceof SimError) return { ok: false, error: { code: err.code, message: err.message, ...(err.details ? { details: err.details } : {}) } };
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
      this.agent.trySend({ t: "logs", workloadId: id, source: "install", lines: lines.map((line) => ({ ts, stream: "stdout", line })) });
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
        if (startup.length) this.agent.trySend({ t: "logs", workloadId: id, lines: startup.map((line) => ({ ts: Date.now(), stream: "stdout", line })) });
        if (crash !== null && crash !== undefined) {
          this.exit(id, crash, true, this.options.oomOnStart ?? false);
        } else if (ready) {
          this.agent.trySend({ t: "logs", workloadId: id, lines: [{ ts: Date.now(), stream: "stdout", line: ready }] });
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
      const id = String(p.workloadId);
      const line = String(p.line);
      this.consoleLines.push({ workloadId: id, line });
      // Minecraft responses (vanilla/Paper wording) for the backup save cycle.
      const out = (msg: string) =>
        this.agent.trySend({ t: "logs", workloadId: id, lines: [{ ts: Date.now() + (this.options.clockSkewMs ?? 0), stream: "stdout", line: `[12:00:00 INFO]: ${msg}` }] });
      if (line === "save-off" && this.options.saveOffConfirm !== false) setTimeout(() => out("Automatic saving is now disabled"), 5);
      if (line === "save-on" && this.options.saveOnConfirm !== false) setTimeout(() => out("Automatic saving is now enabled"), 5);
      if (line === "save-all flush") {
        setTimeout(() => {
          const stray = this.options.saveStrayLines ?? [];
          if (stray.length) this.agent.trySend({ t: "logs", workloadId: id, lines: stray.map((l) => ({ ts: Date.now(), stream: "stdout", line: l })) });
          out("Saving the game (this may take a moment!)");
          if (this.options.saveFailure) out("Unable to save the game (is there enough disk space?)");
          else if (this.options.saveConfirm !== false) out("Saved the game");
        }, 10);
      }
      return {};
    });

    on("workload.logs.tail", (p) => {
      const n = Number(p.lines ?? 500);
      const ts = Date.now() - 60_000;
      return { lines: (this.options.logTail ?? []).slice(-n).map((line, i) => ({ ts: ts + i, stream: "stdout", line })) };
    });

    // --- backups ------------------------------------------------------------------------------
    on("backup.create", (p) => {
      const id = String(p.workloadId);
      const ignore = compileDenylist(p.ignore as string[]);
      const files: Record<string, string> = {};
      let skippedSymlinks = 0;
      for (const [path, e] of this.files(id)) {
        if (path === ".blockforge" || path.startsWith(".blockforge/")) continue;
        if (e.type === "symlink") {
          skippedSymlinks++;
          continue;
        }
        if (e.type !== "file" || ignore.denied(path)) continue;
        files[path] = e.data.toString("utf8");
      }
      const bytes = Buffer.from(JSON.stringify(files));
      const archive = { bytes, sha256: sha(bytes), files };
      if (this.options.exitDuringBackup) this.exit(id, 1, false);
      this.backupArchives.set(`${id}:${String(p.backupId)}`, archive);
      return { sizeBytes: bytes.length, sha256: archive.sha256, files: Object.keys(files).length, skippedSymlinks, durationMs: 5 };
    });
    on("backup.upload", async (p) => {
      const key = `${String(p.workloadId)}:${String(p.backupId)}`;
      const a = this.backupArchives.get(key);
      if (!a) throw new SimError("NOT_FOUND", "no such backup");
      const partSize = Number(p.partSize);
      const parts: { partNumber: number; etag: string }[] = [];
      for (const part of p.parts as { partNumber: number; url: string }[]) {
        const body = a.bytes.subarray((part.partNumber - 1) * partSize, part.partNumber * partSize);
        const res = await fetch(part.url, { method: "PUT", body: new Uint8Array(body) });
        if (!res.ok) throw new SimError("RUNTIME_ERROR", `part ${part.partNumber}: HTTP ${res.status}`);
        parts.push({ partNumber: part.partNumber, etag: res.headers.get("etag") ?? "" });
      }
      if (p.deleteLocal) this.backupArchives.delete(key);
      return { parts };
    });
    on("backup.restore", async (p) => {
      const id = String(p.workloadId);
      const w = this.workloads.get(id);
      if (w && (w.state === "running" || w.state === "restarting")) throw new SimError("BUSY", "the workload must be stopped");
      const src = p.source as { type: "local" } | { type: "url"; url: string };
      let bytes: Buffer;
      if (src.type === "local") {
        const a = this.backupArchives.get(`${id}:${String(p.backupId)}`);
        if (!a) throw new SimError("NOT_FOUND", "no such backup");
        bytes = a.bytes;
      } else {
        const res = await fetch(src.url);
        if (!res.ok) throw new SimError("DOWNLOAD_FAILED", `HTTP ${res.status}`);
        bytes = Buffer.from(await res.arrayBuffer());
      }
      if (sha(bytes) !== p.sha256) throw new SimError("CHECKSUM_MISMATCH", "sha256 mismatch");
      const files = JSON.parse(bytes.toString("utf8")) as Record<string, string>;
      if (p.truncate) for (const k of [...this.files(id).keys()]) if (k !== ".blockforge" && !k.startsWith(".blockforge/")) this.files(id).delete(k);
      for (const [path, content] of Object.entries(files)) this.put(id, path, content);
      return { files: Object.keys(files).length, bytes: bytes.length, durationMs: 5 };
    });
    on("backup.delete", (p) => {
      this.backupArchives.delete(`${String(p.workloadId)}:${String(p.backupId)}`);
      return {};
    });
    on("backup.transfer.push", async (p) => {
      const a = this.backupArchives.get(`${String(p.workloadId)}:${String(p.backupId)}`);
      if (!a) throw new SimError("NOT_FOUND", "no such backup");
      const up = await this.agent.upload(String(p.transferId), a.bytes);
      if (up.status !== 200) throw new SimError("RUNTIME_ERROR", `rendezvous answered ${up.status}`);
      return { bytes: a.bytes.length, sha256: a.sha256 };
    });

    // --- fs.* (symlinks resolved inside the sandbox; `denylist` enforced on requested AND resolved paths) ---
    on("fs.list", (p) => {
      const id = String(p.workloadId);
      const dir = this.resolve(id, String(p.path));
      const files = this.files(id);
      if (dir && files.get(dir)?.type !== "dir") throw new SimError("NOT_FOUND", "no such directory");
      const entries = [...files].filter(([path]) => parentOf(path) === dir).map(([path, e]) => this.entry(path, e));
      return { entries, truncated: false };
    });
    on("fs.stat", (p) => {
      const id = String(p.workloadId);
      const path = this.resolve(id, String(p.path), false);
      const e = this.files(id).get(path);
      if (!e) throw new SimError("NOT_FOUND", "no such file");
      return this.entry(norm(String(p.path)), e);
    });
    on("fs.read", (p) => {
      const id = String(p.workloadId);
      const resolved = this.resolve(id, String(p.path));
      this.deny(p, [norm(String(p.path)), resolved]);
      const e = this.files(id).get(resolved);
      if (!e || e.type !== "file") throw new SimError("NOT_FOUND", "no such file");
      const max = Number(p.maxBytes);
      const slice = e.data.subarray(0, max);
      const text = slice.toString("utf8");
      const utf8 = Buffer.from(text, "utf8").equals(slice);
      return { content: utf8 ? text : slice.toString("base64"), encoding: utf8 ? "utf8" : "base64", sha256: sha(e.data), size: e.data.length, truncated: e.data.length > max };
    });
    on("fs.write", (p) => {
      const id = String(p.workloadId);
      const path = this.resolve(id, String(p.path));
      this.deny(p, [norm(String(p.path)), path]);
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
      const path = this.resolve(id, String(p.path), false);
      this.deny(p, [norm(String(p.path)), path]);
      if (this.files(id).has(path)) throw new SimError("CONFLICT", "already exists");
      this.mkdirs(id, path);
      return {};
    });
    on("fs.rename", (p) => {
      const id = String(p.workloadId);
      const from = this.resolve(id, String(p.from), false);
      const to = this.resolve(id, String(p.to), false);
      this.deny(p, [norm(String(p.from)), from, this.resolve(id, String(p.from)), norm(String(p.to)), to]);
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
      const path = this.resolve(id, String(p.path), false);
      this.deny(p, [norm(String(p.path)), path, this.resolve(id, String(p.path))]);
      const files = this.files(id);
      if (!files.has(path)) throw new SimError("NOT_FOUND", "no such file");
      const children = [...files.keys()].filter((k) => k.startsWith(`${path}/`));
      if (children.length && !p.recursive) throw new SimError("CONFLICT", "directory not empty");
      for (const k of [path, ...children]) files.delete(k);
      return {};
    });
    on("fs.copy", (p) => {
      const id = String(p.workloadId);
      const src = this.resolve(id, String(p.path));
      const files = this.files(id);
      const e = files.get(src);
      if (!e) throw new SimError("NOT_FOUND", "no such file");
      this.deny(p, [norm(String(p.path)), ...this.tree(id, src)]);
      const requested = norm(String(p.path));
      const candidate = (n: number) => [parentOf(requested), copyName(nameOf(requested), n, e.type === "dir")].filter(Boolean).join("/");
      let n = 1;
      while (files.has(candidate(n))) n++;
      const dest = candidate(n);
      this.deny(p, [dest]);
      for (const [path, entry] of [...files]) {
        // Symlinks inside a copied directory are skipped (never followed).
        if (path === src || (path.startsWith(`${src}/`) && entry.type !== "symlink")) files.set(dest + path.slice(src.length), { ...entry, data: Buffer.from(entry.data) });
      }
      return { path: dest };
    });
    on("fs.chmod", (p) => {
      const id = String(p.workloadId);
      const path = this.resolve(id, String(p.path), false);
      this.deny(p, [norm(String(p.path)), path]);
      const e = this.files(id).get(path);
      if (!e) throw new SimError("NOT_FOUND", "no such file");
      if (e.type === "symlink") throw new SimError("PATH_FORBIDDEN", "symlinks cannot be chmodded");
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
      const ext = p.format === "zip" ? ".zip" : ".tar.gz";
      const iso = new Date().toISOString();
      const dest = p.destPath ? norm(String(p.destPath)) : [root, `archive-${iso.slice(0, 10)}T${iso.slice(11, 19).replace(/:/g, "")}Z${ext}`].filter(Boolean).join("/");
      const contents: Record<string, string> = {};
      let entries = 0;
      for (const x of p.paths as string[]) {
        const requested = [root, norm(x)].filter(Boolean).join("/");
        const resolved = this.resolve(id, requested);
        if (!files.has(resolved)) throw new SimError("NOT_FOUND", `${requested} does not exist`);
        const tree = this.tree(id, resolved);
        this.deny(p, [requested, ...tree]);
        entries += tree.length;
        for (const t of tree) {
          const e = files.get(t)!;
          if (e.type === "file") contents[requested + t.slice(resolved.length)] = e.data.toString("utf8");
        }
      }
      this.deny(p, [dest]);
      if (files.has(dest)) throw new SimError("CONFLICT", "archive exists");
      const data = Buffer.from(`archive of ${Object.keys(contents).join(",")}`);
      this.put(id, dest, data);
      this.archives.set(`${id}:${dest}`, contents);
      return { path: dest, size: data.length, entries };
    });
    on("fs.extract", (p) => {
      const id = String(p.workloadId);
      const archive = this.resolve(id, String(p.archivePath));
      this.deny(p, [norm(String(p.archivePath)), archive]);
      if (this.files(id).get(archive)?.type !== "file") throw new SimError("NOT_FOUND", "no such archive");
      const dest = this.resolve(id, String(p.destPath));
      const contents = this.archives.get(`${id}:${archive}`) ?? { "extracted.txt": "extracted" };
      const targets = Object.keys(contents).map((name) => [dest, norm(name)].filter(Boolean).join("/"));
      this.deny(p, [norm(String(p.destPath)), dest, ...targets]);
      let bytes = 0;
      for (const [name, content] of Object.entries(contents)) {
        this.put(id, [dest, norm(name)].filter(Boolean).join("/"), content);
        bytes += Buffer.byteLength(content);
      }
      return { entries: targets.length, bytes };
    });
    on("fs.transfer.pull", async (p) => {
      const id = String(p.workloadId);
      const path = this.resolve(id, String(p.path));
      this.deny(p, [norm(String(p.path)), path]);
      const res = await this.agent.download(String(p.transferId));
      if (res.status !== 200) throw new SimError("RUNTIME_ERROR", `rendezvous answered ${res.status}`);
      const data = Buffer.from(await res.arrayBuffer());
      if (data.length > Number(p.maxBytes)) throw new SimError("QUOTA_EXCEEDED", "transfer larger than announced");
      this.put(id, path, data);
      return { bytes: data.length, sha256: sha(data) };
    });
    on("fs.transfer.push", async (p) => {
      const id = String(p.workloadId);
      const path = this.resolve(id, String(p.path));
      this.deny(p, [norm(String(p.path)), path]);
      const e = this.files(id).get(path);
      if (!e || e.type !== "file") throw new SimError("NOT_FOUND", "no such file");
      const up = await this.agent.upload(String(p.transferId), e.data);
      if (up.status !== 200) throw new SimError("RUNTIME_ERROR", `rendezvous answered ${up.status}`);
      return { bytes: e.data.length, sha256: sha(e.data) };
    });
  }

  /** Enforces a received `denylist` (contracts semantics) on every given path. */
  private deny(p: Record<string, unknown>, paths: readonly string[]): void {
    const list = p.denylist as string[] | undefined;
    if (!list?.length) return;
    const d = compileDenylist(list);
    for (const x of paths) if (x && d.denied(x)) throw denied(x);
  }

  /** A path and everything below it (symlinks inside are listed but never followed). */
  private tree(workloadId: string, path: string): string[] {
    return [...this.files(workloadId).keys()].filter((k) => k === path || k.startsWith(`${path}/`));
  }

  /**
   * Resolves symlinks inside the sandbox like `os.Root` (relative targets only; escaping the root is
   * refused). `followFinal = false` leaves a symlink in the last component unresolved (lstat).
   */
  resolve(workloadId: string, path: string, followFinal = true, depth = 0): string {
    if (depth > 40) throw new SimError("PATH_FORBIDDEN", "too many levels of symbolic links");
    const parts = norm(path).split("/").filter(Boolean);
    let cur = "";
    for (let i = 0; i < parts.length; i++) {
      const next = cur ? `${cur}/${parts[i]}` : parts[i]!;
      const e = this.files(workloadId).get(next);
      if (e?.type === "symlink" && (i < parts.length - 1 || followFinal)) {
        const target = joinInside(parentOf(next), e.target ?? "");
        const rest = parts.slice(i + 1).join("/");
        return this.resolve(workloadId, rest ? `${target}/${rest}` : target, followFinal, depth + 1);
      }
      cur = next;
    }
    return cur;
  }

  /** Creates a symlink `path` → `target` (relative to the link's directory, as on disk). */
  link(workloadId: string, path: string, target: string): void {
    const p = norm(path);
    if (parentOf(p)) this.mkdirs(workloadId, parentOf(p));
    this.files(workloadId).set(p, { type: "symlink", data: Buffer.alloc(0), mode: 0o777, mtime: Date.now(), target });
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
    const e = this.files(workloadId).get(norm(path));
    return e && e.type !== "symlink" ? e.data.toString("utf8") : null;
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
    if (emit) this.agent.trySend({ t: "event", ts: Date.now(), event: "workload.state", data: st });
    return st;
  }

  /** A metrics frame whose workload sample carries SLP status (the agent's game probe). */
  sendSlp(workloadId: string): void {
    const frame = loadFixture<{ node: NodeMetricSample; workloads: WorkloadMetricSample[] }>("metrics.json");
    const ts = Date.now();
    this.agent.trySend({ t: "metrics", ts, node: { ...frame.node, ts }, workloads: [{ ...frame.workloads[0]!, workloadId, ts }] });
  }

  /** Emits a `workload.state` event for the current status. */
  emitState(workloadId: string): void {
    this.agent.trySend({ t: "event", ts: Date.now(), event: "workload.state", data: this.status(workloadId) });
  }
}
