import { OPERATOR_PLAYER_ACTIONS, type PlayerActionKind, type PlayerActionRequest, type PlayerActionResult, type PlayerLookupResponse, type PlayerSession, type PlayersOverview } from "@blockforge/contracts";
import {
  addToWhitelist,
  banIp,
  banPlayer,
  commandFeedbackMessage,
  emptyPlayerList,
  getProperty,
  parseCommandFeedback,
  parsePlayerList,
  parsePlayerListOutput,
  parseProperties,
  playerCommands,
  PlayerInputError,
  removeFromPlayerList,
  MojangRateLimiter,
  resolvePlayerProfile,
  serializePlayerList,
  setOperator,
  toContractPlayerFeedback,
  toContractPlayerLookup,
  toContractPlayersOverview,
  updatePropertiesText,
  type CommandFeedback,
  type PlayerListDocument,
  type PlayerListKind,
  type PlayerListOutput,
  type PlayersOverviewInput,
} from "@blockforge/minecraft";
import { and, desc, eq, lt, or, sql } from "drizzle-orm";
import type { Logger } from "pino";
import type { ConsoleBuffers } from "../agents/console-buffer.js";
import { commandErrorToHttp } from "../agents/errors.js";
import { AgentCommandError, type AgentGateway } from "../agents/gateway.js";
import { actorUserId, type AuditActor, type AuditService } from "../audit/service.js";
import type { Db } from "../db/client.js";
import { playerSessions, users } from "../db/schema/index.js";
import type { Upstreams } from "../extensions/upstream.js";
import { AppError, badRequest, conflict, forbidden, invalidState, notFound, unprocessable } from "../lib/errors.js";
import type { Clock } from "../lib/clock.js";
import { decodeCursor, encodeCursor, TimeIdCursor } from "../lib/pagination.js";
import type { LatestCache } from "../metrics/latest.js";
import type { ServerAccess } from "../servers/access.js";
import { loadRuntimeContext, minecraftGame } from "../servers/runtime.js";
import { ConsoleCommandTracker, sendAndAwait } from "./console.js";
import type { PlayerSessionTracker } from "./sessions.js";

export interface PlayersDeps {
  db: Db;
  clock: Clock;
  logger: Logger;
  gateway: AgentGateway;
  consoles: ConsoleBuffers;
  latest: LatestCache;
  upstreams: Upstreams;
  audit: AuditService;
  sessions: PlayerSessionTracker;
  /** Wait for the server's feedback after a console command (contract: ≤ 5 s). */
  feedbackTimeoutMs?: number;
  /** How long an unconfirmed console command may still be answering (target-less feedback is ambiguous meanwhile). */
  commandLingerMs?: number;
  /**
   * The process-wide Mojang profile limiter (the limit is per IP): every Mojang lookup of the control
   * plane goes through it. Default: one created here (PlayersService is the only Mojang caller).
   */
  mojangLimiter?: MojangRateLimiter;
}

const FILES = { whitelist: "whitelist.json", ops: "ops.json", "banned-players": "banned-players.json", "banned-ips": "banned-ips.json" } as const satisfies Record<PlayerListKind, string>;
const MAX_READ = 5 * 1024 * 1024;
const RUNNING = new Set(["running", "degraded"]);
const STOPPED = new Set(["stopped", "crashed"]);
const ALL_ACTIONS: PlayerActionKind[] = ["kick", "ban", "pardon", "ban-ip", "pardon-ip", "op", "deop", "whitelist-add", "whitelist-remove", "whitelist-set", "whitelist-reload"];
const FILE_ACTIONS: PlayerActionKind[] = ["ban", "pardon", "ban-ip", "pardon-ip", "op", "deop", "whitelist-add", "whitelist-remove", "whitelist-set"];

/** Console feedback the library's `parseCommandFeedback` reports for each action. */
const FEEDBACK_ACTION: Partial<Record<PlayerActionKind, CommandFeedback["action"]>> = {
  kick: "kick",
  ban: "ban",
  pardon: "pardon",
  "ban-ip": "ban-ip",
  "pardon-ip": "pardon-ip",
  op: "op",
  deop: "deop",
  "whitelist-add": "whitelist.add",
  "whitelist-remove": "whitelist.remove",
};

/**
 * Feedback of `whitelist on|off|reload` (not covered by `parseCommandFeedback`): the server's own
 * command-feedback line (strict `commandFeedbackMessage`), 26.3 `en_us.json` / 1.12.2 `en_us.lang` wording.
 */
const WHITELIST_FEEDBACK: Record<"on" | "off" | "reload", RegExp> = {
  on: /^(?:Whitelist is now turned on|Whitelist is already turned on|Turned on the whitelist)$/,
  off: /^(?:Whitelist is now turned off|Whitelist is already turned off|Turned off the whitelist)$/,
  reload: /^Reloaded the whitelist$/,
};

const boolProp = (v: string | undefined): boolean | null => (v === undefined ? null : v.trim().toLowerCase() === "true" ? true : v.trim().toLowerCase() === "false" ? false : null);

type FileError = NonNullable<PlayersOverviewInput["fileErrors"]>[number];

interface ReadFile {
  text: string;
  sha256: string;
}

/** Players (api.md "Players (Phase 4b)"). */
export class PlayersService {
  private readonly commands: ConsoleCommandTracker;
  readonly mojangLimiter: MojangRateLimiter;

  constructor(private readonly d: PlayersDeps) {
    this.commands = new ConsoleCommandTracker(d.gateway, () => d.clock.now(), d.commandLingerMs);
    this.mojangLimiter = d.mojangLimiter ?? new MojangRateLimiter();
  }

  private get console() {
    return { gateway: this.d.gateway, consoles: this.d.consoles, commands: this.commands };
  }

  private async kind(access: ServerAccess): Promise<"java" | "proxy"> {
    const game = minecraftGame(await loadRuntimeContext(this.d.db, access.server.id));
    if (!game) throw unprocessable("This server is not a Minecraft server", { reason: "unsupported_software" });
    return game;
  }

  private async read(access: ServerAccess, path: string): Promise<ReadFile | null> {
    try {
      const r = await this.d.gateway.send(access.server.nodeId, "fs.read", { workloadId: access.server.id, path, maxBytes: MAX_READ }, { timeoutMs: 30_000 });
      if (r.truncated) throw unprocessable(`${path} is larger than ${MAX_READ} bytes`);
      return { text: r.encoding === "base64" ? Buffer.from(r.content, "base64").toString("utf8") : r.content, sha256: r.sha256 };
    } catch (err) {
      if (err instanceof AgentCommandError && err.code === "NOT_FOUND") return null;
      throw commandErrorToHttp(err);
    }
  }

  private async write(access: ServerAccess, path: string, content: string, ifMatch: string | null, actor: AuditActor): Promise<void> {
    try {
      await this.d.gateway.send(
        access.server.nodeId,
        "fs.write",
        { workloadId: access.server.id, path, content, encoding: "utf8", ifMatchSha256: ifMatch, createParents: false },
        { timeoutMs: 30_000, ...(actorUserId(actor) ? { userId: actorUserId(actor)! } : {}) },
      );
    } catch (err) {
      if (err instanceof AgentCommandError && (err.code === "CONFLICT" || err.code === "PRECONDITION_FAILED")) throw conflict(`${path} changed meanwhile; try again`);
      throw commandErrorToHttp(err);
    }
  }

  private availableActions(kind: "java" | "proxy", state: string): PlayerActionKind[] {
    if (kind !== "java") return [];
    if (RUNNING.has(state)) return [...ALL_ACTIONS];
    if (STOPPED.has(state)) return [...FILE_ACTIONS];
    return [];
  }

  /** `list uuids` on the running server (complete list) — null when no recognised answer came. */
  private async listOnline(access: ServerAccess): Promise<PlayerListOutput | null> {
    try {
      return await sendAndAwait(this.console, access.server.nodeId, access.server.id, playerCommands.list({ uuids: true }), (lines) => parsePlayerListOutput(lines), this.d.feedbackTimeoutMs ?? 5000, { quiet: true });
    } catch {
      return null;
    }
  }

  private slpOnline(access: ServerAccess): PlayersOverviewInput["online"] {
    const s = this.d.latest.getWorkload(access.server.id);
    if (!s?.minecraft || this.d.clock.now() - s.ts > 5 * 60_000) return null;
    return { source: "slp", count: s.minecraft.playersOnline, max: s.minecraft.playersMax, sample: s.minecraft.playerSample.map((p) => ({ name: p.name, uuid: p.id })), at: s.ts };
  }

  async overview(access: ServerAccess): Promise<PlayersOverview> {
    const kind = await this.kind(access);
    const state = access.server.state;
    const now = new Date(this.d.clock.now());
    if (kind === "proxy") {
      // Velocity keeps no player lists; the online count is the proxy's Server List Ping answer.
      return toContractPlayersOverview({
        online: RUNNING.has(state) ? this.slpOnline(access) : null,
        onlineMode: null,
        whitelistEnabled: null,
        whitelistEnforced: null,
        lists: {},
        availableActions: [],
        now,
      });
    }
    const fileErrors: FileError[] = [];
    const lists: PlayersOverviewInput["lists"] = {};
    for (const [k, file] of Object.entries(FILES) as [PlayerListKind, (typeof FILES)[PlayerListKind]][]) {
      const f = await this.read(access, file).catch((err: unknown) => {
        if (err instanceof AppError && err.statusCode === 422) {
          fileErrors.push({ file, message: err.message });
          return null;
        }
        throw err;
      });
      if (!f) continue;
      try {
        const doc = parsePlayerList(k, f.text);
        if (k === "whitelist") lists.whitelist = doc as PlayerListDocument<"whitelist">;
        else if (k === "ops") lists.ops = doc as PlayerListDocument<"ops">;
        else if (k === "banned-players") lists.bannedPlayers = doc as PlayerListDocument<"banned-players">;
        else lists.bannedIps = doc as PlayerListDocument<"banned-ips">;
      } catch (err) {
        fileErrors.push({ file, message: err instanceof PlayerInputError ? err.message : "unreadable" });
      }
    }
    const props = await this.properties(access, fileErrors);
    let online: PlayersOverviewInput["online"] = null;
    if (RUNNING.has(state)) {
      const out = await this.listOnline(access);
      if (out) {
        online = { source: "list", output: out, at: now.getTime() };
        void this.d.sessions.reconcile(access.server.id, out.players.map((p) => p.name));
      } else online = this.slpOnline(access);
    }
    return toContractPlayersOverview({
      online,
      onlineMode: props.onlineMode,
      whitelistEnabled: props.whitelist,
      whitelistEnforced: props.enforce,
      lists,
      fileErrors,
      availableActions: this.availableActions(kind, state),
      now,
    });
  }

  private async properties(access: ServerAccess, fileErrors?: FileError[]) {
    const f = await this.read(access, "server.properties").catch((err: unknown) => {
      if (err instanceof AppError && err.statusCode === 422 && fileErrors) {
        fileErrors.push({ file: "server.properties", message: err.message });
        return null;
      }
      throw err;
    });
    if (!f) return { file: null, onlineMode: null, whitelist: null, enforce: null };
    try {
      const doc = parseProperties(f.text);
      return { file: f, onlineMode: boolProp(getProperty(doc, "online-mode")), whitelist: boolProp(getProperty(doc, "white-list")), enforce: boolProp(getProperty(doc, "enforce-whitelist")) };
    } catch (err) {
      fileErrors?.push({ file: "server.properties", message: (err as Error).message });
      return { file: f, onlineMode: null, whitelist: null, enforce: null };
    }
  }

  // --- Actions ------------------------------------------------------------------------------------

  async action(access: ServerAccess, req: PlayerActionRequest, actor: AuditActor): Promise<PlayerActionResult> {
    if (OPERATOR_PLAYER_ACTIONS.includes(req.action) && !access.permissions.has("servers.console.send")) {
      // Audited like the route's own permission check (ServerAccessService.require).
      await this.d.audit.record({
        ...actor,
        action: "authz.denied",
        targetType: "server",
        targetId: access.server.id,
        outcome: "denied",
        details: { permission: "servers.console.send", method: "POST", route: "/api/v1/servers/:id/players/actions", action: req.action },
      });
      throw forbidden("Granting or revoking operator rights also requires servers.console.send");
    }
    const kind = await this.kind(access);
    if (kind !== "java") throw unprocessable("Velocity proxies have no player lists or moderation commands", { reason: "unsupported_software" });
    const state = access.server.state;
    let result: PlayerActionResult;
    if (RUNNING.has(state)) result = await this.viaConsole(access, req, actor);
    else if (STOPPED.has(state)) result = await this.viaFiles(access, req, actor);
    else throw invalidState(`The server is ${state}; try again when it is running or stopped`, { state });
    const { action, ...rest } = req;
    const details: Record<string, unknown> = { action, applied: result.applied, ...rest };
    if (result.feedback) details.ok = result.feedback.ok;
    await this.d.audit.record({ ...actor, action: `server.players.${action}`, targetType: "server", targetId: access.server.id, outcome: "success", details });
    return result;
  }

  private command(req: PlayerActionRequest): string {
    try {
      switch (req.action) {
        case "kick":
          return playerCommands.kick(req.name, req.reason ?? null);
        case "ban":
          return playerCommands.ban(req.name, req.reason ?? null);
        case "pardon":
          return playerCommands.pardon(req.name);
        case "ban-ip":
          return playerCommands.banIp({ ip: req.ip }, req.reason ?? null);
        case "pardon-ip":
          return playerCommands.pardonIp(req.ip);
        case "op":
          return playerCommands.op(req.name);
        case "deop":
          return playerCommands.deop(req.name);
        case "whitelist-add":
          return playerCommands.whitelistAdd(req.name);
        case "whitelist-remove":
          return playerCommands.whitelistRemove(req.name);
        case "whitelist-set":
          return req.enabled ? playerCommands.whitelistOn() : playerCommands.whitelistOff();
        case "whitelist-reload":
          return playerCommands.whitelistReload();
      }
    } catch (err) {
      if (err instanceof PlayerInputError) throw badRequest(err.message);
      throw err;
    }
  }

  private async viaConsole(access: ServerAccess, req: PlayerActionRequest, actor: AuditActor): Promise<PlayerActionResult> {
    if (((req.action === "ban" || req.action === "ban-ip") && req.expiresAt !== undefined) || (req.action === "op" && (req.level !== undefined || req.bypassesPlayerLimit !== undefined))) {
      throw invalidState("Ban expiry and operator level/bypass can only be set while the server is stopped", { reason: "requires_stopped" });
    }
    const line = this.command(req);
    const target = "name" in req ? req.name.toLowerCase() : "ip" in req ? req.ip : null;
    const expected = FEEDBACK_ACTION[req.action];
    type Feedback = { ok: boolean; message: string };
    const toggle = req.action === "whitelist-set" || req.action === "whitelist-reload";
    const relevant = (fb: CommandFeedback) => fb.action === expected || (fb.action === "player" && !fb.ok && "name" in req);
    // Decides at once only on a line naming our target (success or 1.12.2 failure) for this action, and
    // only if no other command with the same action and target (another player action, a console
    // `op Steve`, our own earlier timed-out attempt) overlapped ours: that line could be its answer, so
    // one line never satisfies two waiters. The first such line decides (1.12.2 "Could not op Steve"
    // before "Made Steve …" → ok:false). Lines about another player, and target-less lines, never end
    // the wait: a batch of commands or another operator's command may print them before our answer.
    const decide = (lines: readonly string[], ambiguous: boolean): Feedback | null => {
      if (toggle || ambiguous) return null;
      for (const l of lines) {
        const fb = parseCommandFeedback(l);
        if (fb && relevant(fb) && fb.target !== null && fb.target.toLowerCase() === target) return toContractPlayerFeedback(fb);
      }
      return null;
    };
    // End of the window without a named answer: a target-less line (26.3 "Nothing changed. …", "No player
    // was found", whitelist toggles) is ours only if it is the only feedback seen and no other command was
    // possibly answering at any time during the wait. Otherwise the outcome is unknown (504 no_feedback):
    // an honest "sent, unconfirmed" beats a confident wrong answer.
    const atDeadline = (lines: readonly string[], contended: boolean): Feedback | null => {
      if (contended) return null;
      const candidates: Feedback[] = [];
      for (const l of lines) {
        const fb = parseCommandFeedback(l);
        const msg = commandFeedbackMessage(l);
        const toggleLine = msg !== null && (WHITELIST_FEEDBACK.on.test(msg) || WHITELIST_FEEDBACK.off.test(msg) || WHITELIST_FEEDBACK.reload.test(msg));
        if (toggle) {
          if (fb) return null; // another command's answer
          if (!toggleLine) continue;
          const re = WHITELIST_FEEDBACK[req.action === "whitelist-reload" ? "reload" : req.enabled ? "on" : "off"];
          if (!re.test(msg!)) return null;
          candidates.push({ ok: true, message: msg!.slice(0, 1024) });
          continue;
        }
        if (toggleLine) return null;
        if (!fb) continue;
        // Any named line here is about someone else (ours would have decided): an untracked command answered.
        if (fb.target !== null || !relevant(fb)) return null;
        candidates.push(toContractPlayerFeedback(fb));
      }
      return candidates.length === 1 ? candidates[0]! : null;
    };
    let feedback;
    try {
      feedback = await sendAndAwait(this.console, access.server.nodeId, access.server.id, line, decide, this.d.feedbackTimeoutMs ?? 5000, { userId: actorUserId(actor), atDeadline });
    } catch (err) {
      throw commandErrorToHttp(err);
    }
    if (!feedback) throw new AppError(504, "UPSTREAM_ERROR", "The server did not confirm the command (it was delivered; the outcome is unknown)", { reason: "no_feedback", sent: true });
    return { applied: "console", feedback, overview: null };
  }

  /** Resolves a name for a list entry: Mojang in online mode, the offline-mode UUID otherwise. */
  private async profile(name: string, onlineMode: boolean | null): Promise<{ uuid: string; name: string }> {
    let p;
    try {
      p = await resolvePlayerProfile(this.d.upstreams.mojang, name, { onlineMode: onlineMode ?? true, limiter: this.mojangLimiter });
    } catch (err) {
      throw this.d.upstreams.httpError(err, "mojang", "Player");
    }
    if (!p) throw notFound("Player (no Minecraft account has this name)");
    return { uuid: p.uuid, name: p.name };
  }

  /** `BlockForge (<username>)` — the username, never the e-mail address (the list is readable by every players.view holder). */
  private async banSource(actor: AuditActor): Promise<string> {
    const userId = actorUserId(actor);
    const [u] = userId ? await this.d.db.select({ username: users.username }).from(users).where(eq(users.id, userId)) : [];
    const who = (u?.username ?? "system").replace(/[^A-Za-z0-9_.-]/g, "").slice(0, 64) || "system";
    return `BlockForge (${who})`;
  }

  private async editList<K extends PlayerListKind>(access: ServerAccess, kind: K, actor: AuditActor, fn: (doc: PlayerListDocument<K>) => Promise<PlayerListDocument<K>> | PlayerListDocument<K>): Promise<void> {
    const file = FILES[kind];
    const cur = await this.read(access, file);
    let doc: PlayerListDocument<K>;
    try {
      doc = cur ? parsePlayerList(kind, cur.text) : emptyPlayerList(kind);
    } catch (err) {
      if (err instanceof PlayerInputError) throw unprocessable(`${file} cannot be edited: ${err.message}`);
      throw err;
    }
    let next: PlayerListDocument<K>;
    try {
      next = await fn(doc);
    } catch (err) {
      if (err instanceof PlayerInputError) throw badRequest(err.message);
      throw err;
    }
    await this.write(access, file, serializePlayerList(next), cur?.sha256 ?? null, actor);
  }

  private async viaFiles(access: ServerAccess, req: PlayerActionRequest, actor: AuditActor): Promise<PlayerActionResult> {
    if (req.action === "kick" || req.action === "whitelist-reload") {
      throw invalidState(`${req.action} needs a running server`, { reason: "not_running" });
    }
    const props = await this.properties(access);
    const now = new Date(this.d.clock.now());
    switch (req.action) {
      case "whitelist-add": {
        const p = await this.profile(req.name, props.onlineMode);
        await this.editList(access, "whitelist", actor, (doc) => addToWhitelist(doc, p));
        break;
      }
      case "whitelist-remove":
        await this.editList(access, "whitelist", actor, (doc) => removeFromPlayerList(doc, req.name).doc);
        break;
      case "op": {
        const p = await this.profile(req.name, props.onlineMode);
        await this.editList(access, "ops", actor, (doc) =>
          setOperator(doc, { ...p, ...(req.level !== undefined ? { level: req.level } : {}), ...(req.bypassesPlayerLimit !== undefined ? { bypassesPlayerLimit: req.bypassesPlayerLimit } : {}) }),
        );
        break;
      }
      case "deop":
        await this.editList(access, "ops", actor, (doc) => removeFromPlayerList(doc, req.name).doc);
        break;
      case "ban": {
        const p = await this.profile(req.name, props.onlineMode);
        const source = await this.banSource(actor);
        await this.editList(access, "banned-players", actor, (doc) =>
          banPlayer(doc, { ...p, reason: req.reason ?? null, source, expires: req.expiresAt !== undefined ? new Date(req.expiresAt) : null, now }),
        );
        break;
      }
      case "pardon":
        await this.editList(access, "banned-players", actor, (doc) => removeFromPlayerList(doc, req.name).doc);
        break;
      case "ban-ip": {
        const source = await this.banSource(actor);
        await this.editList(access, "banned-ips", actor, (doc) =>
          banIp(doc, { ip: req.ip, reason: req.reason ?? null, source, expires: req.expiresAt !== undefined ? new Date(req.expiresAt) : null, now }),
        );
        break;
      }
      case "pardon-ip":
        await this.editList(access, "banned-ips", actor, (doc) => removeFromPlayerList(doc, req.ip).doc);
        break;
      case "whitelist-set": {
        const text = props.file?.text ?? "";
        let next: string;
        try {
          next = updatePropertiesText(text, { "white-list": req.enabled });
        } catch (err) {
          throw unprocessable(`server.properties cannot be edited: ${(err as Error).message}`);
        }
        await this.write(access, "server.properties", next, props.file?.sha256 ?? null, actor);
        break;
      }
    }
    return { applied: "file", feedback: null, overview: await this.overview(access) };
  }

  // --- Lookup and sessions ----------------------------------------------------------------------------

  async lookup(access: ServerAccess, name: string): Promise<PlayerLookupResponse> {
    const kind = await this.kind(access);
    const onlineMode = kind === "java" ? (await this.properties(access)).onlineMode : true;
    let p;
    try {
      p = await resolvePlayerProfile(this.d.upstreams.mojang, name, { onlineMode: onlineMode ?? true, limiter: this.mojangLimiter });
    } catch (err) {
      throw this.d.upstreams.httpError(err, "mojang", "Player");
    }
    if (!p) throw notFound("Player");
    return toContractPlayerLookup(p);
  }

  async sessions(access: ServerAccess, q: { limit: number; cursor?: string | undefined; name?: string | undefined }): Promise<{ items: PlayerSession[]; nextCursor: string | null }> {
    const cursor = decodeCursor(TimeIdCursor, q.cursor);
    const conds = [eq(playerSessions.serverId, access.server.id)];
    if (q.name) conds.push(sql`lower(${playerSessions.name}) = ${q.name.toLowerCase()}`);
    if (cursor) {
      const t = new Date(cursor.t);
      conds.push(or(lt(playerSessions.joinedAt, t), and(eq(playerSessions.joinedAt, t), lt(playerSessions.id, cursor.id)))!);
    }
    const rows = await this.d.db
      .select()
      .from(playerSessions)
      .where(and(...conds))
      .orderBy(desc(playerSessions.joinedAt), desc(playerSessions.id))
      .limit(q.limit + 1);
    const page = rows.slice(0, q.limit);
    const last = page.at(-1);
    return {
      items: page.map((s) => ({
        id: s.id,
        serverId: s.serverId,
        name: s.name,
        uuid: s.uuid,
        joinedAt: s.joinedAt.getTime(),
        leftAt: s.leftAt?.getTime() ?? null,
        leaveReason: s.leaveReason,
      })),
      nextCursor: rows.length > q.limit && last ? encodeCursor({ t: last.joinedAt.getTime(), id: last.id }) : null,
    };
  }
}
