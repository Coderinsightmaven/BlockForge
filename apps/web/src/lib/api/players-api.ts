import {
  PlayerActionResult,
  PlayerLookupResponse,
  PlayerSessionPage,
  PlayersOverview,
} from "@blockforge/contracts";
import type { PlayerActionRequest } from "@blockforge/contracts";
import type { z } from "zod";
import { apiClient } from "./client";

/*
 * Players routes (docs/architecture/api.md). Imported only by the lazily loaded Players tab (kept
 * apart from the extensions routes so that tab doesn't carry the extensions contracts).
 */

type In<T extends z.ZodType> = z.input<T>;
const enc = encodeURIComponent;

export const playersApi = {
  overview: (serverId: string, signal?: AbortSignal) =>
    apiClient.get(`/servers/${enc(serverId)}/players`, { schema: PlayersOverview, signal }),
  action: (serverId: string, body: In<typeof PlayerActionRequest>) =>
    apiClient.post(`/servers/${enc(serverId)}/players/actions`, { body, schema: PlayerActionResult }),
  lookup: (serverId: string, name: string, signal?: AbortSignal) =>
    apiClient.get(`/servers/${enc(serverId)}/players/lookup`, {
      query: { name },
      schema: PlayerLookupResponse,
      signal,
    }),
  sessions: (
    serverId: string,
    q: { limit?: number; cursor?: string | null; name?: string },
    signal?: AbortSignal,
  ) =>
    apiClient.get(`/servers/${enc(serverId)}/players/sessions`, {
      query: { limit: q.limit, cursor: q.cursor ?? undefined, name: q.name || undefined },
      schema: PlayerSessionPage,
      signal,
    }),
};
