import type { Readable } from "node:stream";
import {
  DownloadUrlQuery,
  FileChmodRequest,
  FileCompressRequest,
  FileContentQuery,
  FileCopyRequest,
  FileDecompressRequest,
  FileDeleteRequest,
  FileListQuery,
  FileMkdirRequest,
  FileRenameRequest,
  FileSearchQuery,
  FileWriteRequest,
  UploadUrlRequest,
} from "@blockforge/contracts";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { AppContext } from "../context.js";
import { actorOf, requireSession } from "../http/auth-hooks.js";
import { parse } from "../http/validation.js";
import { AppError, notFound, validationDetails } from "../lib/errors.js";
import { normalizePath } from "./policy.js";

/** `archive-<UTC yyyy-mm-ddThhmmssZ>.<ext>`, the agent's default archive name. */
export function archiveName(format: "tar.gz" | "zip", now: number): string {
  const iso = new Date(now).toISOString();
  return `archive-${iso.slice(0, 10)}T${iso.slice(11, 19).replace(/:/g, "")}Z.${format}`;
}

const IdParams = z.object({ id: z.uuid() });
const TokenParams = z.object({ token: z.string().regex(/^[A-Za-z0-9_-]{43}$/) });

export function registerFileRoutes(app: FastifyInstance, ctx: AppContext): void {
  const f = ctx.files;
  const access = ctx.serverAccess;
  // Browser uploads are streamed, never buffered or parsed.
  app.addContentTypeParser("application/octet-stream", (_req, payload, done) => done(null, payload));

  const read = (req: Parameters<typeof access.require>[0]) => access.require(req, parse(IdParams, req.params, "Path").id, "servers.files.read");
  const write = (req: Parameters<typeof access.require>[0]) => access.require(req, parse(IdParams, req.params, "Path").id, "servers.files.write");

  app.get("/servers/:id/files/list", async (req) => f.list(await read(req), parse(FileListQuery, req.query, "Query").path, actorOf(req)));
  app.get("/servers/:id/files/contents", async (req) => f.read(await read(req), parse(FileContentQuery, req.query, "Query").path, actorOf(req)));
  app.put("/servers/:id/files/contents", async (req) => f.write(await write(req), parse(FileWriteRequest, req.body), actorOf(req)));
  app.get("/servers/:id/files/search", async (req) => f.search(await read(req), parse(FileSearchQuery, req.query, "Query"), actorOf(req)));

  app.post("/servers/:id/files/rename", async (req, reply) => {
    await f.rename(await write(req), parse(FileRenameRequest, req.body).renames, actorOf(req));
    return reply.status(204).send();
  });
  app.post("/servers/:id/files/delete", async (req, reply) => {
    await f.remove(await write(req), parse(FileDeleteRequest, req.body).paths, actorOf(req));
    return reply.status(204).send();
  });
  app.post("/servers/:id/files/copy", async (req) => f.copy(await write(req), parse(FileCopyRequest, req.body).path, actorOf(req)));
  app.post("/servers/:id/files/mkdir", async (req, reply) => {
    await f.mkdir(await write(req), parse(FileMkdirRequest, req.body).path, actorOf(req));
    return reply.status(204).send();
  });
  app.post("/servers/:id/files/chmod", async (req, reply) => {
    await f.chmod(await write(req), parse(FileChmodRequest, req.body).files, actorOf(req));
    return reply.status(204).send();
  });
  app.post("/servers/:id/files/compress", async (req, reply) => {
    const a = await write(req);
    const body = parse(FileCompressRequest, req.body);
    // The output path is chosen here (the agent's naming scheme) so it is checked like any other path.
    const destPath = [normalizePath(body.root), archiveName(body.format, ctx.clock.now())].filter(Boolean).join("/");
    const sources = body.paths.map((p) => [body.root, p].filter(Boolean).join("/"));
    const r = await f.archive(a, "compress", { nodeId: a.server.nodeId, root: body.root, paths: body.paths, format: body.format, destPath }, [...sources, destPath], actorOf(req));
    return reply.status(r.status).send(r.body);
  });
  app.post("/servers/:id/files/decompress", async (req, reply) => {
    const a = await write(req);
    const body = parse(FileDecompressRequest, req.body);
    const r = await f.archive(a, "decompress", { nodeId: a.server.nodeId, path: body.path, destination: body.destination }, [body.path, ...(body.destination ? [body.destination] : [])], actorOf(req));
    return reply.status(r.status).send(r.body);
  });

  app.post("/servers/:id/files/upload-url", async (req) => f.uploadUrl(await write(req), requireSession(req).id, parse(UploadUrlRequest, req.body)));
  app.get("/servers/:id/files/download-url", async (req) => f.downloadUrl(await read(req), requireSession(req).id, parse(DownloadUrlQuery, req.query, "Query").path));

  // --- Single-use transfer URLs --------------------------------------------------------------
  app.put("/transfers/:token", { bodyLimit: Number.MAX_SAFE_INTEGER, config: { csrf: "token" } }, async (req) => {
    const { token } = parse(TokenParams, req.params, "Path");
    const t = ctx.browserTransfers.consume(token, requireSession(req).id, "upload");
    if (!t) throw notFound("Transfer");
    // Current access (revoked grants, suspension) decides, not the state when the URL was issued.
    const a = await access.require(req, t.serverId, "servers.files.write");
    const body = req.body as Readable | undefined;
    if (!body || typeof body.pipe !== "function") {
      throw new AppError(415, "VALIDATION_FAILED", "Uploads must be sent as application/octet-stream", validationDetails("content-type must be application/octet-stream"));
    }
    return f.receiveUpload(a, t, body, actorOf(req));
  });

  app.get("/transfers/:token", async (req, reply) => {
    const { token } = parse(TokenParams, req.params, "Path");
    const t = ctx.browserTransfers.consume(token, requireSession(req).id, "download");
    if (!t) throw notFound("Transfer");
    const a = await access.require(req, t.serverId, "servers.files.read");
    const stream = await f.sendDownload(a, t, actorOf(req));
    const name = (t.path.split("/").pop() ?? "download").replace(/[^A-Za-z0-9._-]+/g, "_");
    reply.header("content-type", "application/octet-stream");
    reply.header("content-disposition", `attachment; filename="${name}"`);
    return reply.send(stream);
  });
}
