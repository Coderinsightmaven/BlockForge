import { z } from "zod";
import { EpochMs, Id, PageQuery, page } from "../common.js";
import { PlayerName, PlayerUuid } from "./player-events.js";

export { PlayerJoinedEvent, PlayerLeftEvent, PlayerName, PlayerUuid } from "./player-events.js";

/**
 * Players (Phase 4b): `/servers/:id/players/*`. Reads need `servers.players.view`, actions
 * `servers.players.manage` (`op`/`deop` additionally `servers.console.send`, see `PlayerActionRequest`).
 *
 * Sources: the online list comes from the console `list` command (running server, exact names + UUIDs)
 * or the last Server List Ping sample; whitelist/ops/bans are read from `whitelist.json`, `ops.json`,
 * `banned-players.json`, `banned-ips.json` and `server.properties` (`white-list`, `enforce-whitelist`,
 * `online-mode`). Everything read from those files or from the console is untrusted text: names in the
 * JSON files are not guaranteed to be valid player names, and reasons/sources are free text.
 * Velocity proxies have no lists and no built-in moderation commands (`availableActions` is empty).
 */

/**
 * Address for IP bans: a dotted IPv4 quad without leading zeros. The server keys IP bans by the IPv4 string
 * of the client address (IPv4-mapped clients arrive as IPv4), so IPv6 bans could never match and are refused,
 * as are IPv4-mapped IPv6 spellings, ports, zones and CIDR ranges.
 */
export const BanIpAddress = z
  .string()
  .regex(/^(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(\.(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)){3}$/, "IPv4 address like 203.0.113.7");

/** `MAX_REASON_LENGTH` of the library. Single line: no control, format or line/paragraph separator characters. */
export const MAX_PLAYER_REASON_LENGTH = 200;
export const PlayerReason = z
  .string()
  .trim()
  .min(1)
  .max(MAX_PLAYER_REASON_LENGTH)
  .regex(/^[^\p{Cc}\p{Cf}\p{Zl}\p{Zp}]*$/u, "single line without control characters");

/** Latest year the ban-list date format can hold (`yyyy-MM-dd …`). */
const MAX_BAN_EXPIRY_MS = 253_402_300_799_999;

export const OnlinePlayer = z.object({ name: PlayerName, uuid: PlayerUuid.nullable() });
export type OnlinePlayer = z.infer<typeof OnlinePlayer>;

export const PlayerListFile = z.enum(["whitelist.json", "ops.json", "banned-players.json", "banned-ips.json", "server.properties"]);
export const PlayerListKind = z.enum(["whitelist", "ops", "bannedPlayers", "bannedIps"]);

export const PlayerActionKind = z.enum([
  "kick",
  "ban",
  "pardon",
  "ban-ip",
  "pardon-ip",
  "op",
  "deop",
  "whitelist-add",
  "whitelist-remove",
  "whitelist-set",
  "whitelist-reload",
]);
export type PlayerActionKind = z.infer<typeof PlayerActionKind>;

/** Max entries returned per list; longer lists are cut and named in `truncated`. */
export const MAX_PLAYER_LIST_ENTRIES = 10_000;

/** Ban entry fields. Dates are converted to epoch ms; unparsable dates are null (the server treats an unparsable expiry as permanent). */
const BanFields = {
  createdAt: EpochMs.nullable(),
  /** Untrusted (`(Unknown)`, `Server`, a player or plugin name, `BlockForge (alice)`). */
  source: z.string().max(256),
  /** null = permanent (`forever`, or an unparsable date). */
  expiresAt: EpochMs.nullable(),
  reason: z.string().max(256).nullable(),
  /** In force now (permanent, or expiry in the future). */
  active: z.boolean(),
};

/** `GET /servers/:id/players`. Missing data is null/empty, never invented. */
export const PlayersOverview = z.object({
  online: z.object({
    /** null = unknown (server not running, no `list`/SLP data yet). */
    count: z.number().int().nonnegative().nullable(),
    max: z.number().int().nonnegative().nullable(),
    /** Names are always valid player names; UUIDs come from `list uuids` (null from SLP samples of offline servers). */
    players: z.array(OnlinePlayer).max(1000),
    /** Entries of the source dropped because they were not valid player names. */
    skipped: z.number().int().nonnegative(),
    /** `list` = console command (complete list), `slp` = Server List Ping sample (may be partial). */
    source: z.enum(["list", "slp"]).nullable(),
    at: EpochMs.nullable(),
  }),
  /** `online-mode` from server.properties (null when unknown). */
  onlineMode: z.boolean().nullable(),
  whitelist: z.object({
    /** `white-list` in server.properties. */
    enabled: z.boolean().nullable(),
    /** `enforce-whitelist`: kick non-whitelisted players when the whitelist is (re)loaded. */
    enforced: z.boolean().nullable(),
    entries: z.array(z.object({ uuid: PlayerUuid, name: z.string().max(64) })).max(MAX_PLAYER_LIST_ENTRIES),
  }),
  ops: z
    .array(
      z.object({
        uuid: PlayerUuid,
        name: z.string().max(64),
        /** 0–4; out-of-range file values are reported in `listErrors` and clamped. */
        level: z.number().int().min(0).max(4),
        bypassesPlayerLimit: z.boolean(),
      }),
    )
    .max(MAX_PLAYER_LIST_ENTRIES),
  bannedPlayers: z.array(z.object({ uuid: PlayerUuid, name: z.string().max(64), ...BanFields })).max(MAX_PLAYER_LIST_ENTRIES),
  bannedIps: z.array(z.object({ ip: z.string().max(64), ...BanFields })).max(MAX_PLAYER_LIST_ENTRIES),
  /** Lists cut at `MAX_PLAYER_LIST_ENTRIES`. */
  truncated: z.array(PlayerListKind),
  /** Unreadable files and invalid entries (the server ignores them; they are kept unchanged on edits). */
  listErrors: z.array(z.object({ file: PlayerListFile, message: z.string().max(512) })).max(64),
  /** Actions possible right now for this server (software + state); the UI renders only these. */
  availableActions: z.array(PlayerActionKind),
});
export type PlayersOverview = z.infer<typeof PlayersOverview>;

const BanExpiry = EpochMs.max(MAX_BAN_EXPIRY_MS);

/**
 * `POST /servers/:id/players/actions` (strict: unknown keys are refused so a misspelt field never silently
 * turns a timed ban into a permanent one).
 *
 * Running server → the library builds the console command (validated names/IPs, sanitised reason), the
 * agent types it, and the control plane waits ≤ 5 s for the server's own feedback line. Stopped server →
 * the JSON list (or `server.properties` for `whitelist-set`) is edited atomically (`fs.write` with
 * `ifMatchSha256`), resolving the UUID via Mojang in online mode and the offline UUID otherwise.
 *
 * Errors: `kick` and `whitelist-reload` on a stopped server → 409 `INVALID_STATE` (`details.reason:
 * "not_running"`); `expiresAt`, `op.level` or `op.bypassesPlayerLimit` on a running server (the console
 * commands cannot express them) → 409 `INVALID_STATE` (`"requires_stopped"`); transitional states
 * (starting/stopping/…) → 409 `INVALID_STATE`; no attributable feedback within the timeout (none, ambiguous
 * with another command, or only target-less lines while another command could be answering) → 504
 * `UPSTREAM_ERROR` (`details: {reason: "no_feedback", sent: true}` — the command was sent, its outcome is
 * unknown); a console command the agent refused or could not deliver → that agent error (503/504/502),
 * except that feedback already attributed before an error that leaves open whether the line reached the
 * server (timeout, disconnect, runtime error) is still returned; unknown premium name → 404 `NOT_FOUND`; Mojang throttling → 429 `RATE_LIMITED`
 * (`upstream: "mojang"`); Velocity / non-Minecraft servers → 422 `PRECONDITION_FAILED`
 * (`"unsupported_software"`).
 *
 * `op`/`deop` grant or revoke operator rights (arbitrary in-game commands): besides `servers.players.manage`
 * they require `servers.console.send`, which is operator-equivalent already.
 */
export const PlayerActionRequest = z.discriminatedUnion("action", [
  z.object({ action: z.literal("kick"), name: PlayerName, reason: PlayerReason.optional() }).strict(),
  z.object({ action: z.literal("ban"), name: PlayerName, reason: PlayerReason.optional(), expiresAt: BanExpiry.optional() }).strict(),
  z.object({ action: z.literal("pardon"), name: PlayerName }).strict(),
  z.object({ action: z.literal("ban-ip"), ip: BanIpAddress, reason: PlayerReason.optional(), expiresAt: BanExpiry.optional() }).strict(),
  z.object({ action: z.literal("pardon-ip"), ip: BanIpAddress }).strict(),
  z
    .object({
      action: z.literal("op"),
      name: PlayerName,
      level: z.number().int().min(1).max(4).optional(),
      bypassesPlayerLimit: z.boolean().optional(),
    })
    .strict(),
  z.object({ action: z.literal("deop"), name: PlayerName }).strict(),
  z.object({ action: z.literal("whitelist-add"), name: PlayerName }).strict(),
  z.object({ action: z.literal("whitelist-remove"), name: PlayerName }).strict(),
  z.object({ action: z.literal("whitelist-set"), enabled: z.boolean() }).strict(),
  z.object({ action: z.literal("whitelist-reload") }).strict(),
]);
export type PlayerActionRequest = z.infer<typeof PlayerActionRequest>;

/** Actions that additionally need `servers.console.send` (operator escalation). */
export const OPERATOR_PLAYER_ACTIONS: readonly PlayerActionKind[] = ["op", "deop"];

export const PlayerActionResult = z.object({
  applied: z.enum(["console", "file"]),
  /** Console path: the server's feedback (message is untrusted console text). Null for file edits. */
  feedback: z.object({ ok: z.boolean(), message: z.string().max(1024) }).nullable(),
  /** Fresh overview after a file edit (null when not re-read, e.g. after console commands). */
  overview: PlayersOverview.nullable(),
});
export type PlayerActionResult = z.infer<typeof PlayerActionResult>;

/** `GET /servers/:id/players/lookup?name=` — 404 `NOT_FOUND` for unknown premium names. */
export const PlayerLookupQuery = z.object({ name: PlayerName });
export const PlayerLookupResponse = z.object({
  /** Mojang's capitalisation for `mojang`; as requested for `offline`. */
  name: PlayerName,
  uuid: PlayerUuid,
  /** `mojang` when the server runs in online mode, else the offline-mode UUID. */
  source: z.enum(["mojang", "offline"]),
});
export type PlayerLookupResponse = z.infer<typeof PlayerLookupResponse>;

/**
 * A play session derived from the server's join/leave console lines (trusted only from the server's own
 * logger). Sessions still open when the server stops/crashes, or when the player is missing from the next
 * `list`, are closed at that time with `leaveReason: null`. Retention: 90 days.
 */
export const PlayerSession = z.object({
  id: Id,
  serverId: Id,
  name: PlayerName,
  uuid: PlayerUuid.nullable(),
  joinedAt: EpochMs,
  leftAt: EpochMs.nullable(),
  /** Disconnect reason from the console (untrusted). */
  leaveReason: z.string().max(256).nullable(),
});
export type PlayerSession = z.infer<typeof PlayerSession>;

/** `GET /servers/:id/players/sessions` → `Page<PlayerSession>`, newest first; `name` matches case-insensitively. */
export const PlayerSessionQuery = PageQuery.extend({ name: PlayerName.optional() });
export const PlayerSessionPage = page(PlayerSession);

