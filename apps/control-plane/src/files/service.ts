import { randomUUID } from "node:crypto";
import type { Readable } from "node:stream";
import { MutableRelativePath, type FileEntry } from "@blockforge/contracts";
import type { Logger } from "pino";
import { z } from "zod";
import { AgentCommandError, type AgentGateway } from "../agents/gateway.js";
import { commandErrorToHttp } from "../agents/errors.js";
import type { TransferBroker } from "../agents/transfers.js";
import type { AuditActor, AuditService } from "../audit/service.js";
import type { JobRunner } from "../jobs/runner.js";
import { JobError, type JobDefinition } from "../jobs/types.js";
import { AppError, badRequest, conflict, forbidden, notFound, validationDetails } from "../lib/errors.js";
import type { ServerAccess } from "../servers/access.js";
import type { TemplatesService } from "../templates/service.js";
import type { BrowserTransfers } from "./browser-transfers.js";
import { isDenied, isSecretBearing, MAX_AGENT_DENYLIST, normalizePath, redactForDisplay, SECRET_BEARING_FILES, SECRET_DENY_PATTERNS } from "./policy.js";

const EDITOR_MAX_BYTES = 5 * 1024 * 1024;
const DOWNLOAD_MAX_BYTES = 16 * 1024 ** 3;
const ARCHIVE_MAX_BYTES = 16 * 1024 ** 3;
const ARCHIVE_MAX_ENTRIES = 200_000;
/** Archive jobs answered synchronously when they finish within this time; otherwise 202 + jobId. */
const ARCHIVE_SYNC_WAIT_MS = 15_000;

export const FILE_JOBS = { compress: "server.files.compress", decompress: "server.files.decompress" } as const;

/** The agent refused a path (or the target of a symlink in it) because of the denylist it was sent. */
export function isDenylistRefusal(err: unknown): boolean {
  return err instanceof AgentCommandError && err.code === "PATH_FORBIDDEN" && (err.details as { reason?: unknown } | undefined)?.reason === "denylist";
}

const pathDenied = () => new AppError(403, "PATH_DENIED", "That path, or the file a link in it points to, is protected on this server");

/** Agent errors → API errors for file operations. */
function fsError(err: unknown): unknown {
  if (!(err instanceof AgentCommandError)) return err;
  if (isDenylistRefusal(err)) return pathDenied();
  switch (err.code) {
    case "NOT_FOUND":
      return notFound("File");
    case "PATH_FORBIDDEN":
      return forbidden("That path is outside the server's files");
    case "CONFLICT":
    case "ALREADY_EXISTS":
      return new AppError(409, "CONFLICT", err.message);
    case "QUOTA_EXCEEDED":
      return new AppError(409, "CAPACITY_EXCEEDED", err.message);
    default:
      return commandErrorToHttp(err);
  }
}

export interface FilesDeps {
  gateway: AgentGateway;
  audit: AuditService;
  templates: TemplatesService;
  transfers: TransferBroker;
  browser: BrowserTransfers;
  jobs: JobRunner;
  logger: Logger;
}

/**
 * File manager over the agent's sandboxed `fs.*` commands. Template denylists apply to everyone
 * without `servers.admin`; secret-bearing proxy files are redacted (and not writable/downloadable)
 * without `secrets.read`.
 */
export class FilesService {
  constructor(private readonly d: FilesDeps) {}

  private async denylist(access: ServerAccess): Promise<string[]> {
    if (access.permissions.has("servers.admin")) return [];
    return (await this.d.templates.row(access.server.templateId)).fileDenylist;
  }

  /**
   * The denylist the agent enforces on requested AND symlink-resolved paths (descendants for
   * copy/compress/extract). The requested-path checks here are only a fast first layer.
   *  - template `fileDenylist` unless the requester holds `servers.admin`;
   *  - secret-bearing files (appended last, so template `!` rules cannot re-allow them) for
   *    requesters without `secrets.read`: always for single-file content (an alias must not bypass
   *    redaction), for bulk copies/archives only on network members (where BlockForge manages the
   *    forwarding secret — every Paper server has config/paper-global.yml, so applying it everywhere
   *    would forbid archiving a server's root). `readSelf` keeps a secret file readable (redacted)
   *    through its own name while aliases to other secret files stay refused.
   */
  private async agentDeny(access: ServerAccess, scope: "plain" | "content" | "bulk", readSelf?: string): Promise<{ denylist?: string[] }> {
    const out = [...(await this.denylist(access))];
    if (!access.permissions.has("secrets.read") && (scope === "content" || (scope === "bulk" && access.resource.networkId))) {
      out.push(...SECRET_DENY_PATTERNS);
      if (readSelf && isSecretBearing(readSelf)) out.push(`!/${normalizePath(readSelf)}`);
    }
    if (!out.length) return {};
    if (out.length > MAX_AGENT_DENYLIST) {
      throw new AppError(422, "PRECONDITION_FAILED", `The template's file denylist is too long to enforce (at most ${MAX_AGENT_DENYLIST - SECRET_DENY_PATTERNS.length - 1} patterns)`);
    }
    return { denylist: out };
  }

  private async guard(access: ServerAccess, paths: readonly string[], opts: { secretWrite?: boolean } = {}): Promise<void> {
    const deny = await this.denylist(access);
    for (const p of paths) {
      if (isDenied(p, deny)) throw new AppError(403, "PATH_DENIED", `${normalizePath(p) || "/"} is on this server's file denylist`, { path: normalizePath(p) });
      if (opts.secretWrite && isSecretBearing(p) && !access.permissions.has("secrets.read")) {
        throw new AppError(403, "REDACTED_CONTENT", `${normalizePath(p)} holds proxy secrets and is shown redacted; saving it requires secrets.read`, { path: normalizePath(p) });
      }
    }
  }

  private async send<T extends Parameters<AgentGateway["send"]>[1]>(access: ServerAccess, type: T, payload: Parameters<AgentGateway["send"]>[2], actor: AuditActor, timeoutMs = 30_000) {
    try {
      return await this.d.gateway.send(access.server.nodeId, type, payload as never, { userId: actor.actorId, timeoutMs });
    } catch (err) {
      throw fsError(err);
    }
  }

  private audit(actor: AuditActor, access: ServerAccess, action: string, details: Record<string, unknown>): Promise<void> {
    return this.d.audit.record({ ...actor, action: `server.file.${action}`, targetType: "server", targetId: access.server.id, outcome: "success", details });
  }

  async list(access: ServerAccess, path: string, actor: AuditActor): Promise<{ path: string; entries: FileEntry[]; truncated: boolean }> {
    // Denied entries still appear in listings (Wings semantics); only their contents are protected.
    if (normalizePath(path)) await this.guard(access, [path]);
    const r = (await this.send(access, "fs.list", { workloadId: access.server.id, path }, actor)) as { entries: FileEntry[]; truncated: boolean };
    return { path: normalizePath(path), entries: r.entries, truncated: r.truncated ?? false };
  }

  async read(access: ServerAccess, path: string, actor: AuditActor) {
    await this.guard(access, [path]);
    const deny = await this.agentDeny(access, "content", path);
    const r = (await this.send(access, "fs.read", { workloadId: access.server.id, path, maxBytes: EDITOR_MAX_BYTES, ...deny }, actor)) as {
      content: string;
      encoding: "utf8" | "base64";
      sha256: string;
      size: number;
      truncated: boolean;
    };
    let content = r.content;
    let redacted = false;
    if (isSecretBearing(path) && !access.permissions.has("secrets.read") && r.encoding === "utf8") {
      const out = redactForDisplay(path, content);
      content = out.content;
      redacted = out.redacted;
    }
    return { path: normalizePath(path), content, encoding: r.encoding, sha256: r.sha256, size: r.size, truncated: r.truncated, redacted };
  }

  async write(access: ServerAccess, req: { path: string; content: string; encoding: "utf8" | "base64"; baseSha256?: string | null | undefined }, actor: AuditActor) {
    await this.guard(access, [req.path], { secretWrite: true });
    const deny = await this.agentDeny(access, "content");
    const r = await this.send(
      access,
      "fs.write",
      {
        workloadId: access.server.id,
        ...deny,
        path: req.path,
        content: req.content,
        encoding: req.encoding,
        ...(req.baseSha256 !== undefined ? { ifMatchSha256: req.baseSha256 } : {}),
        createParents: true,
      },
      actor,
    );
    await this.audit(actor, access, "write", { path: normalizePath(req.path) });
    return r as { sha256: string; size: number };
  }

  async rename(access: ServerAccess, renames: { from: string; to: string }[], actor: AuditActor): Promise<void> {
    await this.guard(access, renames.flatMap((r) => [r.from, r.to]), { secretWrite: true });
    if (!access.permissions.has("secrets.read") && access.resource.networkId) {
      // Moving a directory that holds a managed secret file would strip its name-based protection.
      for (const r of renames) {
        const from = normalizePath(r.from);
        if (SECRET_BEARING_FILES.some((f) => f.startsWith(`${from}/`))) {
          throw new AppError(403, "REDACTED_CONTENT", `${from} contains proxy secret files; moving it requires secrets.read`, { path: from });
        }
      }
    }
    const deny = await this.agentDeny(access, "plain");
    for (const r of renames) await this.send(access, "fs.rename", { workloadId: access.server.id, from: r.from, to: r.to, ...deny }, actor);
    await this.audit(actor, access, "rename", { renames: renames.map((r) => ({ from: normalizePath(r.from), to: normalizePath(r.to) })) });
  }

  async remove(access: ServerAccess, paths: string[], actor: AuditActor): Promise<void> {
    await this.guard(access, paths, { secretWrite: true });
    const deny = await this.agentDeny(access, "plain");
    for (const p of paths) await this.send(access, "fs.delete", { workloadId: access.server.id, path: p, recursive: true, ...deny }, actor, 120_000);
    await this.audit(actor, access, "delete", { paths: paths.map(normalizePath) });
  }

  async copy(access: ServerAccess, path: string, actor: AuditActor): Promise<{ path: string }> {
    await this.guard(access, [path], { secretWrite: true });
    const deny = await this.agentDeny(access, "bulk");
    const r = (await this.send(access, "fs.copy", { workloadId: access.server.id, path, ...deny }, actor, 120_000)) as { path: string };
    await this.audit(actor, access, "copy", { path: normalizePath(path), to: r.path });
    return r;
  }

  async mkdir(access: ServerAccess, path: string, actor: AuditActor): Promise<void> {
    await this.guard(access, [path]);
    await this.send(access, "fs.mkdir", { workloadId: access.server.id, path, ...(await this.agentDeny(access, "plain")) }, actor);
    await this.audit(actor, access, "mkdir", { path: normalizePath(path) });
  }

  async chmod(access: ServerAccess, files: { path: string; mode: string }[], actor: AuditActor): Promise<void> {
    await this.guard(access, files.map((f) => f.path), { secretWrite: true });
    const deny = await this.agentDeny(access, "plain");
    for (const f of files) await this.send(access, "fs.chmod", { workloadId: access.server.id, path: f.path, mode: parseInt(f.mode, 8), ...deny }, actor);
    await this.audit(actor, access, "chmod", { files: files.map((f) => ({ path: normalizePath(f.path), mode: f.mode })) });
  }

  async search(access: ServerAccess, q: { path: string; q: string; limit: number }, actor: AuditActor) {
    if (normalizePath(q.path)) await this.guard(access, [q.path]);
    const r = (await this.send(access, "fs.find", { workloadId: access.server.id, path: q.path, query: q.q, maxResults: q.limit }, actor, 60_000)) as {
      matches: FileEntry[];
      truncated: boolean;
    };
    const deny = await this.denylist(access);
    return { matches: r.matches.filter((m) => !isDenied(m.path, deny)), truncated: r.truncated };
  }

  /** Archive operations run as jobs; quick ones are answered synchronously. */
  async archive(
    access: ServerAccess,
    kind: "compress" | "decompress",
    input: Record<string, unknown>,
    paths: readonly string[],
    actor: AuditActor,
  ): Promise<{ status: number; body: unknown }> {
    await this.guard(access, paths);
    // Extraction writes files (secret files must not be planted); archives read them (bulk).
    const deny = await this.agentDeny(access, kind === "decompress" ? "content" : "bulk");
    const jobId = await this.d.jobs.enqueue(FILE_JOBS[kind], { serverId: access.server.id, ...input, ...deny }, { targetType: "server", targetId: access.server.id, requestedBy: actor.actorId });
    await this.audit(actor, access, kind, { ...input, jobId });
    try {
      const row = await this.d.jobs.waitForCompletion(jobId, ARCHIVE_SYNC_WAIT_MS);
      if (row.status === "succeeded") return { status: 200, body: row.result };
      if (row.error?.code === "PATH_DENIED") throw pathDenied();
      throw new AppError(502, "UPSTREAM_ERROR", row.error?.message ?? `${kind} failed`, { jobId });
    } catch (err) {
      if (err instanceof AppError) throw err;
      return { status: 202, body: { jobId } };
    }
  }

  jobDefinitions(): JobDefinition<never>[] {
    const Denylist = z.array(z.string().max(512)).max(MAX_AGENT_DENYLIST).optional();
    const Compress = z.object({
      serverId: z.uuid(),
      nodeId: z.uuid(),
      root: z.string(),
      paths: z.array(z.string()).min(1),
      format: z.enum(["tar.gz", "zip"]),
      destPath: z.string().optional(),
      denylist: Denylist,
    });
    const Decompress = z.object({ serverId: z.uuid(), nodeId: z.uuid(), path: z.string(), destination: z.string(), denylist: Denylist });
    const deny = (d: string[] | undefined) => (d ? { denylist: d } : {});
    const wrap = (err: unknown): never => {
      if (isDenylistRefusal(err)) throw new JobError("PATH_DENIED", "a path in the selection, or a file a link in it points to, is protected on this server");
      if (err instanceof AgentCommandError) throw new JobError(err.code, err.message, err.retryable);
      throw err;
    };
    const compress: JobDefinition<z.infer<typeof Compress>> = {
      type: FILE_JOBS.compress,
      input: Compress,
      cancelPermission: "servers.files.write",
      retryLimit: 0,
      steps: [
        {
          key: "compress",
          label: "Create the archive",
          run: async (ctx) => {
            const r = await this.d.gateway
              .send(
                ctx.input.nodeId,
                "fs.compress",
                {
                  workloadId: ctx.input.serverId,
                  root: ctx.input.root,
                  paths: ctx.input.paths,
                  format: ctx.input.format,
                  ...(ctx.input.destPath ? { destPath: ctx.input.destPath } : {}),
                  maxTotalBytes: ARCHIVE_MAX_BYTES,
                  ...deny(ctx.input.denylist),
                },
                { jobId: ctx.jobId, signal: ctx.signal, timeoutMs: 15 * 60_000 },
              )
              .catch(wrap);
            ctx.state.result = { path: r.path, size: r.size, entries: r.entries };
            await ctx.log("info", `Created ${r.path} (${r.entries} entries, ${r.size} bytes)`);
          },
        },
      ],
      result: (state) => state.result ?? null,
    };
    const decompress: JobDefinition<z.infer<typeof Decompress>> = {
      type: FILE_JOBS.decompress,
      input: Decompress,
      cancelPermission: "servers.files.write",
      retryLimit: 0,
      steps: [
        {
          key: "extract",
          label: "Extract the archive",
          run: async (ctx) => {
            const r = await this.d.gateway
              .send(
                ctx.input.nodeId,
                "fs.extract",
                { workloadId: ctx.input.serverId, archivePath: ctx.input.path, destPath: ctx.input.destination, maxTotalBytes: ARCHIVE_MAX_BYTES, maxEntries: ARCHIVE_MAX_ENTRIES, ...deny(ctx.input.denylist) },
                { jobId: ctx.jobId, signal: ctx.signal, timeoutMs: 15 * 60_000 },
              )
              .catch(wrap);
            ctx.state.result = { path: ctx.input.destination, size: r.bytes, entries: r.entries };
            await ctx.log("info", `Extracted ${r.entries} entries (${r.bytes} bytes)`);
          },
        },
      ],
      result: (state) => state.result ?? null,
    };
    return [compress, decompress] as unknown as JobDefinition<never>[];
  }

  // --- Browser transfers ---------------------------------------------------------------

  async uploadUrl(access: ServerAccess, sessionId: string, req: { directory: string; fileName: string; size: number }) {
    const path = [normalizePath(req.directory), req.fileName].filter(Boolean).join("/");
    if (!MutableRelativePath.safeParse(path).success) throw badRequest("Invalid file name", validationDetails("invalid file name", "fileName"));
    await this.guard(access, [path], { secretWrite: true });
    const t = this.d.browser.issue({ direction: "upload", sessionId, userId: access.principal.userId, serverId: access.server.id, nodeId: access.server.nodeId, path, maxBytes: req.size });
    return { url: `/api/v1/transfers/${t.token}`, expiresAt: t.expiresAt };
  }

  async downloadUrl(access: ServerAccess, sessionId: string, path: string) {
    await this.guard(access, [path]);
    if (isSecretBearing(path) && !access.permissions.has("secrets.read")) {
      throw new AppError(403, "REDACTED_CONTENT", `${normalizePath(path)} holds proxy secrets; downloading it requires secrets.read`, { path: normalizePath(path) });
    }
    const t = this.d.browser.issue({ direction: "download", sessionId, userId: access.principal.userId, serverId: access.server.id, nodeId: access.server.nodeId, path, maxBytes: DOWNLOAD_MAX_BYTES });
    return { url: `/api/v1/transfers/${t.token}`, expiresAt: t.expiresAt };
  }

  /**
   * Streams a browser upload to the agent: the body is offered on the transfer rendezvous and the
   * agent pulls it (`fs.transfer.pull`) into a temp file, renamed on success. Nothing is buffered.
   */
  async receiveUpload(access: ServerAccess, t: { serverId: string; nodeId: string; path: string; maxBytes: number; userId: string }, body: Readable, actor: AuditActor): Promise<{ bytes: number; sha256: string }> {
    // Checked again at use: access, denylist or the template may have changed since the URL was issued.
    await this.guard(access, [t.path], { secretWrite: true });
    const deny = await this.agentDeny(access, "content");
    const transferId = randomUUID();
    const offered = this.d.transfers.offerDownload({ id: transferId, nodeId: t.nodeId, maxBytes: t.maxBytes }, body);
    offered.catch(() => undefined);
    let result: { bytes: number; sha256: string };
    try {
      result = await this.d.gateway.send(
        t.nodeId,
        "fs.transfer.pull",
        { workloadId: t.serverId, path: t.path, transferId, maxBytes: t.maxBytes, ...deny },
        { userId: t.userId, timeoutMs: 15 * 60_000 },
      );
    } catch (err) {
      this.d.transfers.cancel(transferId);
      throw fsError(err);
    }
    await offered.catch((err: unknown) => {
      throw conflict(`upload stream failed: ${(err as Error).message}`);
    });
    await this.d.audit.record({ ...actor, action: "server.file.upload", targetType: "server", targetId: t.serverId, outcome: "success", details: { path: t.path, bytes: result.bytes, sha256: result.sha256 } });
    return result;
  }

  /** Streams a file from the agent (`fs.transfer.push`) straight into the HTTP response. */
  async sendDownload(access: ServerAccess, t: { serverId: string; nodeId: string; path: string; maxBytes: number; userId: string }, actor: AuditActor): Promise<Readable> {
    await this.guard(access, [t.path]);
    if (isSecretBearing(t.path) && !access.permissions.has("secrets.read")) {
      throw new AppError(403, "REDACTED_CONTENT", `${normalizePath(t.path)} holds proxy secrets; downloading it requires secrets.read`, { path: normalizePath(t.path) });
    }
    const deny = await this.agentDeny(access, "content");
    const transferId = randomUUID();
    const incoming = this.d.transfers.expectUpload({ id: transferId, nodeId: t.nodeId, maxBytes: t.maxBytes });
    const pushed = this.d.gateway.send(
      t.nodeId,
      "fs.transfer.push",
      { workloadId: t.serverId, path: t.path, transferId, ...deny },
      { userId: t.userId, timeoutMs: 15 * 60_000 },
    );
    const first = await Promise.race([incoming.then((s) => ({ stream: s })), pushed.then(() => ({ stream: null }), (err: unknown) => ({ error: err }))]);
    if ("error" in first) {
      this.d.transfers.cancel(transferId);
      throw fsError(first.error);
    }
    const stream = first.stream ?? (await incoming);
    pushed.then(
      (r) => void this.d.audit.record({ ...actor, action: "server.file.download", targetType: "server", targetId: t.serverId, outcome: "success", details: { path: t.path, bytes: r.bytes } }),
      (err: unknown) => {
        this.d.logger.warn({ err, serverId: t.serverId }, "file download push failed");
        stream.destroy(err instanceof Error ? err : new Error(String(err)));
      },
    );
    return stream;
  }
}
