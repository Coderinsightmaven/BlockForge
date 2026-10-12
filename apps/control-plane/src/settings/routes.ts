import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { AppContext } from "../context.js";
import { actorOf, requirePermission } from "../http/auth-hooks.js";
import { zodDetails } from "../http/errors.js";
import { parse } from "../http/validation.js";
import { badRequest, notFound } from "../lib/errors.js";
import { GLOBAL } from "../rbac/authorize.js";
import { SETTINGS, type SettingKey } from "./service.js";

const KeyParams = z.object({ key: z.string().max(100) });
const PutBody = z.object({ value: z.unknown() });

function settingKey(key: string): SettingKey {
  if (!(key in SETTINGS)) throw notFound("Setting");
  return key as SettingKey;
}

/** `GET|PUT /settings/:key` for the known, schema-validated installation settings (settings.manage). */
export function registerSettingsRoutes(app: FastifyInstance, ctx: AppContext): void {
  app.get("/settings/:key", async (req) => {
    await requirePermission(ctx.audit, req, "settings.manage", GLOBAL);
    const key = settingKey(parse(KeyParams, req.params, "Path").key);
    return { key, value: await ctx.settings.get(key) };
  });

  app.put("/settings/:key", async (req) => {
    const principal = await requirePermission(ctx.audit, req, "settings.manage", GLOBAL);
    const key = settingKey(parse(KeyParams, req.params, "Path").key);
    const { value } = parse(PutBody, req.body);
    const parsed = SETTINGS[key].safeParse(value);
    if (!parsed.success) throw badRequest("Invalid setting value", zodDetails(parsed.error));
    await ctx.settings.set(key, parsed.data, principal.userId);
    await ctx.audit.record({ ...actorOf(req), action: "settings.update", targetType: "setting", targetId: key, outcome: "success", details: { value: parsed.data } });
    return { key, value: parsed.data };
  });
}
