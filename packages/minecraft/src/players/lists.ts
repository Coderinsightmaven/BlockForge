import { PlayerInputError, assertPlayerName, assertUuid, normalizeUuid } from "./uuid.js";

/**
 * Editors for the server's JSON player lists — `whitelist.json`, `ops.json`,
 * `banned-players.json`, `banned-ips.json` (`net.minecraft.server.players.StoredUserList`).
 * Field names, the `yyyy-MM-dd HH:mm:ss Z` date format, `"forever"` and `"(Unknown)"` were read
 * from the 26.3 server jar; the files are written by `new GsonBuilder().setPrettyPrinting()`
 * (2-space indent, HTML-safe escaping), which `serializePlayerList` reproduces.
 *
 * Edits keep every entry's unknown keys and key order and keep entries this library cannot
 * validate (reported in `issues`) instead of silently dropping them. The control plane should
 * only write these files while the server is stopped (a running server overwrites them); use the
 * console command builders for running servers.
 */

export type PlayerListKind = "whitelist" | "ops" | "banned-players" | "banned-ips";

export const PLAYER_LIST_FILES: Readonly<Record<PlayerListKind, string>> = {
  whitelist: "whitelist.json",
  ops: "ops.json",
  "banned-players": "banned-players.json",
  "banned-ips": "banned-ips.json",
};

export interface WhitelistEntry {
  uuid: string;
  name: string;
}

export interface OpEntry {
  uuid: string;
  name: string;
  /** 1–4 (`op-permission-level`; the server default is 4). */
  level: number;
  bypassesPlayerLimit: boolean;
}

export interface BanFields {
  /** `yyyy-MM-dd HH:mm:ss Z` as stored. */
  created: string;
  source: string;
  /** `"forever"` or a `yyyy-MM-dd HH:mm:ss Z` date. */
  expires: string;
  reason: string | null;
}

export interface PlayerBanEntry extends BanFields {
  uuid: string;
  name: string;
}

export interface IpBanEntry extends BanFields {
  ip: string;
}

export interface PlayerListEntryMap {
  whitelist: WhitelistEntry;
  ops: OpEntry;
  "banned-players": PlayerBanEntry;
  "banned-ips": IpBanEntry;
}

/** Parsed list: `entries` are the valid entries; `raw` keeps every original array item (same order, written back as-is). */
export interface PlayerListDocument<K extends PlayerListKind = PlayerListKind> {
  kind: K;
  entries: Array<PlayerListEntryMap[K]>;
  raw: unknown[];
  issues: string[];
}

export const BAN_FOREVER = "forever";
export const BAN_SOURCE_UNKNOWN = "(Unknown)";
const MAX_ENTRIES = 100_000;
const MAX_TEXT = 256;

// --- dates ------------------------------------------------------------------------------------

const BAN_DATE_RE = /^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2}):(\d{2}) ([+-])(\d{2})(\d{2})$/;

/** Formats a date like the server (`yyyy-MM-dd HH:mm:ss Z`), in UTC (`+0000`). */
export function formatBanDate(date: Date): string {
  if (!Number.isFinite(date.getTime())) throw new PlayerInputError("invalid date");
  const p = (n: number, w = 2) => String(n).padStart(w, "0");
  return `${p(date.getUTCFullYear(), 4)}-${p(date.getUTCMonth() + 1)}-${p(date.getUTCDate())} ${p(date.getUTCHours())}:${p(date.getUTCMinutes())}:${p(date.getUTCSeconds())} +0000`;
}

/** Parses `yyyy-MM-dd HH:mm:ss Z` (any offset); null for `"forever"` or invalid values. */
export function parseBanDate(value: string): Date | null {
  const m = BAN_DATE_RE.exec(value);
  if (!m) return null;
  const [, y, mo, d, h, mi, s, sign, oh, om] = m;
  const utc = Date.UTC(Number(y), Number(mo) - 1, Number(d), Number(h), Number(mi), Number(s));
  const offset = (Number(oh) * 60 + Number(om)) * 60_000 * (sign === "-" ? -1 : 1);
  const date = new Date(utc - offset);
  return Number.isFinite(date.getTime()) ? date : null;
}

/** Whether a ban is still in force at `now` (`forever` or unparsable expiry → in force, like the server). */
export function isBanActive(entry: Pick<BanFields, "expires">, now: Date): boolean {
  if (entry.expires === BAN_FOREVER) return true;
  const until = parseBanDate(entry.expires);
  return until === null ? true : until.getTime() > now.getTime();
}

// --- text and IP validation ------------------------------------------------------------------

// eslint-disable-next-line no-control-regex
const LINE_BREAKING = /[\u0000-\u001f\u007f\u0085\u2028\u2029]/;

/** Reason/source text stored in a ban list: single line, ≤ 256 characters. */
export function assertListText(value: string, what: string): string {
  if (LINE_BREAKING.test(value)) throw new PlayerInputError(`${what} must be a single line without control characters`);
  if (value.length > MAX_TEXT) throw new PlayerInputError(`${what} is longer than ${MAX_TEXT} characters`);
  return value;
}

const IPV4 = /^(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(\.(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)){3}$/;

/** IPv4 dotted quad or IPv6 literal (no brackets, ports, zones or CIDR). Returns the canonical form or null. */
export function normalizeIp(input: string): string | null {
  const s = input.trim();
  if (IPV4.test(s)) return s;
  if (!/^[0-9A-Fa-f:.]{2,45}$/.test(s) || !s.includes(":")) return null;
  try {
    const host = new URL(`http://[${s}]/`).hostname;
    return host.slice(1, -1);
  } catch {
    return null;
  }
}

// --- parse / serialize ------------------------------------------------------------------------

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function own(o: Record<string, unknown>, k: string): unknown {
  return Object.hasOwn(o, k) ? o[k] : undefined;
}

function str(o: Record<string, unknown>, k: string): string | null {
  const v = own(o, k);
  return typeof v === "string" ? v : null;
}

function banFields(o: Record<string, unknown>): BanFields {
  return {
    created: str(o, "created") ?? "",
    source: str(o, "source") ?? BAN_SOURCE_UNKNOWN,
    expires: str(o, "expires") ?? BAN_FOREVER,
    reason: str(o, "reason"),
  };
}

function toEntry<K extends PlayerListKind>(kind: K, o: Record<string, unknown>): PlayerListEntryMap[K] | string {
  if (kind === "banned-ips") {
    const ip = str(o, "ip");
    if (!ip || normalizeIp(ip) === null) return "invalid or missing ip";
    return { ip, ...banFields(o) } as PlayerListEntryMap[K];
  }
  const rawUuid = str(o, "uuid");
  const uuid = rawUuid ? normalizeUuid(rawUuid) : null;
  if (!uuid) return "invalid or missing uuid";
  const name = str(o, "name") ?? "";
  if (kind === "whitelist") return { uuid, name } as PlayerListEntryMap[K];
  if (kind === "ops") {
    const level = own(o, "level");
    const bypass = own(o, "bypassesPlayerLimit");
    return {
      uuid,
      name,
      level: typeof level === "number" && Number.isInteger(level) ? level : 4,
      bypassesPlayerLimit: bypass === true,
    } as PlayerListEntryMap[K];
  }
  return { uuid, name, ...banFields(o) } as PlayerListEntryMap[K];
}

/**
 * Parses a player list file. An empty file is an empty list (the server writes `[]`). Throws
 * `PlayerInputError` only when the document is not a JSON array.
 */
export function parsePlayerList<K extends PlayerListKind>(kind: K, text: string): PlayerListDocument<K> {
  const trimmed = text.replace(/^\uFEFF/, "").trim();
  if (trimmed === "") return { kind, entries: [], raw: [], issues: [] };
  if (trimmed.length > 64 * 1024 * 1024) throw new PlayerInputError(`${PLAYER_LIST_FILES[kind]} is too large`);
  let data: unknown;
  try {
    data = JSON.parse(trimmed);
  } catch {
    throw new PlayerInputError(`${PLAYER_LIST_FILES[kind]} is not valid JSON`);
  }
  if (!Array.isArray(data)) throw new PlayerInputError(`${PLAYER_LIST_FILES[kind]} must contain a JSON array`);
  if (data.length > MAX_ENTRIES) throw new PlayerInputError(`${PLAYER_LIST_FILES[kind]} has too many entries`);
  const doc: PlayerListDocument<K> = { kind, entries: [], raw: [], issues: [] };
  data.forEach((item: unknown, i) => {
    doc.raw.push(item);
    if (!isRecord(item)) {
      doc.issues.push(`entry ${i + 1}: not an object (kept unchanged)`);
      return;
    }
    const e = toEntry(kind, item);
    if (typeof e === "string") doc.issues.push(`entry ${i + 1}: ${e} (the server ignores it; kept unchanged)`);
    else doc.entries.push(e);
  });
  return doc;
}

const GSON_ESCAPES: Record<string, string> = {
  "<": "\\u003c",
  ">": "\\u003e",
  "&": "\\u0026",
  "=": "\\u003d",
  "'": "\\u0027",
  "\u2028": "\\u2028",
  "\u2029": "\\u2029",
};

/**
 * Serialises like the server's Gson (pretty printing, HTML-safe escaping, no trailing newline).
 * Those characters can only occur inside JSON strings here, so escaping the whole text is exact.
 */
export function serializePlayerList(doc: Pick<PlayerListDocument, "raw">): string {
  if (doc.raw.length === 0) return "[]";
  return JSON.stringify(doc.raw, null, 2).replace(/[<>&='\u2028\u2029]/g, (c) => GSON_ESCAPES[c]!);
}

// --- edits ------------------------------------------------------------------------------------

function keyOf(kind: PlayerListKind, o: unknown): string | null {
  if (!isRecord(o)) return null;
  if (kind === "banned-ips") {
    const ip = str(o, "ip");
    return ip ? normalizeIp(ip) : null;
  }
  const u = str(o, "uuid");
  return u ? normalizeUuid(u) : null;
}

function rebuild<K extends PlayerListKind>(kind: K, raw: unknown[], issues: string[]): PlayerListDocument<K> {
  const entries: Array<PlayerListEntryMap[K]> = [];
  for (const r of raw) {
    if (!isRecord(r)) continue;
    const e = toEntry(kind, r);
    if (typeof e !== "string") entries.push(e);
  }
  return { kind, entries, raw, issues };
}

/** Inserts or updates the entry with the same UUID (IP for `banned-ips`), keeping unknown keys. */
function upsert<K extends PlayerListKind>(doc: PlayerListDocument<K>, fields: Record<string, unknown>): PlayerListDocument<K> {
  const key = keyOf(doc.kind, fields);
  const raw = doc.raw.map((r) => {
    if (!isRecord(r) || keyOf(doc.kind, r) !== key) return r;
    const copy: Record<string, unknown> = {};
    for (const k of Object.keys(r)) Object.defineProperty(copy, k, { value: r[k], enumerable: true, writable: true, configurable: true });
    for (const [k, v] of Object.entries(fields)) copy[k] = v;
    return copy;
  });
  if (!doc.raw.some((r) => keyOf(doc.kind, r) === key)) raw.push(fields);
  return rebuild(doc.kind, raw, doc.issues);
}

/** Removes entries matching a UUID, an IP (`banned-ips`) or a player name (case-insensitive). */
export function removeFromPlayerList<K extends PlayerListKind>(doc: PlayerListDocument<K>, target: string): { doc: PlayerListDocument<K>; removed: number } {
  const t = target.trim();
  const asKey = doc.kind === "banned-ips" ? normalizeIp(t) : normalizeUuid(t);
  const lowerName = t.toLowerCase();
  const raw = doc.raw.filter((r) => {
    if (!isRecord(r)) return true;
    if (asKey !== null && keyOf(doc.kind, r) === asKey) return false;
    if (doc.kind !== "banned-ips" && asKey === null && (str(r, "name") ?? "").toLowerCase() === lowerName && t !== "") return false;
    return true;
  });
  return { doc: rebuild(doc.kind, raw, doc.issues), removed: doc.raw.length - raw.length };
}

export function emptyPlayerList<K extends PlayerListKind>(kind: K): PlayerListDocument<K> {
  return { kind, entries: [], raw: [], issues: [] };
}

export function addToWhitelist(doc: PlayerListDocument<"whitelist">, player: { uuid: string; name: string }): PlayerListDocument<"whitelist"> {
  return upsert(doc, { uuid: assertUuid(player.uuid), name: assertPlayerName(player.name) });
}

export function setOperator(
  doc: PlayerListDocument<"ops">,
  player: { uuid: string; name: string; level?: number; bypassesPlayerLimit?: boolean },
): PlayerListDocument<"ops"> {
  const level = player.level ?? 4;
  if (!Number.isInteger(level) || level < 1 || level > 4) throw new PlayerInputError("operator level must be 1–4");
  return upsert(doc, { uuid: assertUuid(player.uuid), name: assertPlayerName(player.name), level, bypassesPlayerLimit: player.bypassesPlayerLimit ?? false });
}

export interface BanInput {
  reason?: string | null;
  /** Who banned (e.g. `BlockForge (alice)`); default `(Unknown)` like the server. */
  source?: string;
  /** null/undefined = permanent. */
  expires?: Date | null;
  now: Date;
}

function banRecord(input: BanInput): Record<string, unknown> {
  const reason = input.reason === undefined || input.reason === null || input.reason.trim() === "" ? null : assertListText(input.reason.trim(), "reason");
  const out: Record<string, unknown> = {
    created: formatBanDate(input.now),
    source: assertListText(input.source ?? BAN_SOURCE_UNKNOWN, "source"),
    expires: input.expires ? formatBanDate(input.expires) : BAN_FOREVER,
  };
  if (input.expires && input.expires.getTime() <= input.now.getTime()) throw new PlayerInputError("the ban would already have expired");
  if (reason !== null) out["reason"] = reason;
  return out;
}

export function banPlayer(doc: PlayerListDocument<"banned-players">, player: { uuid: string; name: string } & BanInput): PlayerListDocument<"banned-players"> {
  return upsert(doc, { uuid: assertUuid(player.uuid), name: assertPlayerName(player.name), ...banRecord(player) });
}

export function banIp(doc: PlayerListDocument<"banned-ips">, input: { ip: string } & BanInput): PlayerListDocument<"banned-ips"> {
  const ip = normalizeIp(input.ip);
  if (!ip) throw new PlayerInputError("invalid IP address");
  return upsert(doc, { ip, ...banRecord(input) });
}
