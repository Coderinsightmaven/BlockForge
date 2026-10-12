import { z } from "zod";
import { CatalogError } from "../errors.js";
import { getText, parseJson, type CatalogContext } from "../http.js";
import { assertPlayerName, normalizeUuid, offlinePlayerUuid } from "./uuid.js";

/** Mojang profile API (verified live 2026-10-12: 200 `{id, name}`, 404 `{path, errorMessage}`, names case-insensitive). */
export const MOJANG_PROFILE_API = "https://api.mojang.com/users/profiles/minecraft/";
export const MOJANG_PROFILE_HOSTS: readonly string[] = ["api.mojang.com"];

const ProfileSchema = z.object({ id: z.string().regex(/^[0-9a-f]{32}$/), name: z.string().regex(/^[A-Za-z0-9_]{1,16}$/) });

export interface PlayerProfile {
  /** Dashed lowercase UUID. */
  uuid: string;
  /** Name with Mojang's capitalisation. */
  name: string;
  source: "mojang" | "offline";
}

/**
 * Looks up an online-mode (Mojang/Microsoft account) player by name. Returns null when no account
 * has that name. Requests only go to `api.mojang.com` (overridable via `ctx.metadataHosts`), with
 * the usual redirect/size checks; HTTP 429 becomes `RATE_LIMITED` (Mojang allows roughly 600
 * requests per 10 minutes per IP — cache results via `ctx.cache`).
 */
export async function lookupMojangProfile(ctx: CatalogContext, name: string): Promise<PlayerProfile | null> {
  const url = MOJANG_PROFILE_API + encodeURIComponent(assertPlayerName(name));
  const scoped: CatalogContext = { ...ctx, metadataHosts: ctx.metadataHosts ?? MOJANG_PROFILE_HOSTS };
  let text: string;
  try {
    text = await getText(scoped, url);
  } catch (err) {
    if (err instanceof CatalogError && err.code === "NOT_FOUND") return null;
    if (err instanceof CatalogError && err.status === 429) throw new CatalogError("RATE_LIMITED", "Mojang profile API rate limit reached", { url, status: 429, retryAfterMs: 60_000, cause: err });
    throw err;
  }
  // Older API versions answered 204 No Content for unknown names.
  if (text.trim() === "") return null;
  const p = parseJson(text, ProfileSchema, url);
  // The API matches names case-insensitively; anything else is not the player we asked for.
  if (p.name.toLowerCase() !== name.toLowerCase()) throw new CatalogError("INVALID_UPSTREAM_RESPONSE", "Mojang returned a different player than requested", { url });
  return { uuid: normalizeUuid(p.id)!, name: p.name, source: "mojang" };
}

/**
 * Resolves the UUID the server will use for `name`: the Mojang account UUID when the server runs
 * in online mode (or behind a proxy that forwards online-mode identities), otherwise the
 * offline-mode name UUID.
 */
export async function resolvePlayerProfile(ctx: CatalogContext, name: string, opts: { onlineMode: boolean }): Promise<PlayerProfile | null> {
  if (opts.onlineMode) return lookupMojangProfile(ctx, name);
  return { uuid: offlinePlayerUuid(assertPlayerName(name)), name, source: "offline" };
}
