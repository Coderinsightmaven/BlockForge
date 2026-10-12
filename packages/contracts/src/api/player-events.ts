import { z } from "zod";
import { EpochMs, Id } from "../common.js";

/* Player names/UUIDs and realtime payloads, kept apart from `players.ts` so that `realtime.ts` (loaded on every
 * page of the web app) does not pull in the whole players API. Re-exported by `players.ts`. */

/** Java Edition player name (the library's `PLAYER_NAME_RE`): no selectors, spaces or line breaks. */
export const PlayerName = z.string().regex(/^[A-Za-z0-9_]{1,16}$/, "1–16 letters, digits or underscores");
export type PlayerName = z.infer<typeof PlayerName>;
/** Dashed lowercase UUID of any version (online-mode accounts are v4, offline-mode players v3). */
export const PlayerUuid = z.string().regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/, "dashed lowercase UUID");
export type PlayerUuid = z.infer<typeof PlayerUuid>;

/**
 * Realtime, published on `server:<id>` and delivered only to subscribers holding `servers.players.view` on
 * that server. Clients patch the online list and prepend/close sessions; on reconnect they refetch.
 */
export const PlayerJoinedEvent = z.object({
  serverId: Id,
  name: PlayerName,
  uuid: PlayerUuid.nullable(),
  at: EpochMs,
  sessionId: Id.nullable(),
});
export const PlayerLeftEvent = PlayerJoinedEvent.extend({ reason: z.string().max(256).nullable() });
