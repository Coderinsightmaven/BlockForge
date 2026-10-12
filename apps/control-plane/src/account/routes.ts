import { CreateApiKeyRequest, CreateSshKeyRequest } from "@blockforge/contracts";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { AppContext } from "../context.js";
import { actorOf, requirePrincipal } from "../http/auth-hooks.js";
import { parse } from "../http/validation.js";
import { accountPermissions } from "./permissions.js";

const KeyParams = z.object({ id: z.uuid() });

/** `/account/*`: the signed-in user's own settings (SSH keys for SFTP). */
export function registerAccountRoutes(app: FastifyInstance, ctx: AppContext): void {
  app.get("/account/ssh-keys", async (req) => ctx.sshKeys.list(requirePrincipal(req).userId));

  app.post("/account/ssh-keys", { config: { rateLimit: { max: 30, timeWindow: "1 minute" } } }, async (req, reply) => {
    const principal = requirePrincipal(req);
    const body = parse(CreateSshKeyRequest, req.body);
    const key = await ctx.sshKeys.add(principal.userId, body, actorOf(req));
    reply.status(201);
    return key;
  });

  // Session or API key (the one /account route keys may use; limited to the key's permissions).
  app.get("/account/permissions", async (req) => accountPermissions(ctx.db, requirePrincipal(req)));

  // --- Personal API keys (session only: /account refuses API keys; creation needs an MFA-verified session) ---
  app.get("/account/api-keys", async (req) => ctx.apiKeys.list(requirePrincipal(req).userId));

  app.post("/account/api-keys", { config: { rateLimit: { max: 20, timeWindow: "1 minute" } } }, async (req, reply) => {
    const principal = requirePrincipal(req);
    const body = parse(CreateApiKeyRequest, req.body);
    const created = await ctx.apiKeys.create(principal.userId, body, actorOf(req));
    reply.status(201);
    return created;
  });

  app.delete("/account/api-keys/:id", async (req, reply) => {
    const principal = requirePrincipal(req);
    const { id } = parse(KeyParams, req.params, "Path");
    await ctx.apiKeys.remove(principal.userId, id, actorOf(req));
    return reply.status(204).send();
  });

  app.delete("/account/ssh-keys/:id", async (req, reply) => {
    const principal = requirePrincipal(req);
    const { id } = parse(KeyParams, req.params, "Path");
    await ctx.sshKeys.remove(principal.userId, id, actorOf(req));
    return reply.status(204).send();
  });
}
