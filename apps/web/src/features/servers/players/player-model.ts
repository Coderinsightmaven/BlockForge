import type { InfiniteData } from "@tanstack/react-query";
import { OPERATOR_PLAYER_ACTIONS, RateLimitedErrorDetails } from "@blockforge/contracts";
import type { Page, PlayerActionKind, PlayerSession, PlayersOverview, Server } from "@blockforge/contracts";
import { describeError, isApiError } from "@/lib/api/errors";
import { formatTimestamp } from "@/lib/format";
import { serverActionable, serverCan } from "@/lib/server-permissions";

/*
 * Pure rules for the Players tab: which actions to offer (the overview's `availableActions` decides
 * what exists; permissions decide who may), which fields need a stopped server, how errors read, and
 * how live join/leave events patch the cached overview and sessions. Names, reasons and sources from
 * the server's files and console are untrusted text (rendered as text only).
 */

/** Stopped servers are edited through the JSON lists (file path); running ones via console commands. */
export function serverStopped(server: Pick<Server, "state">): boolean {
  return server.state === "stopped" || server.state === "crashed";
}

export interface ActionGate {
  /** The overview lists the action for this software/state: render the control at all. */
  offered: boolean;
  /** The current user may use it. */
  allowed: boolean;
  reason: string | null;
}

export function actionGate(
  server: Pick<Server, "myPermissions" | "suspended">,
  overview: Pick<PlayersOverview, "availableActions">,
  action: PlayerActionKind,
): ActionGate {
  if (!overview.availableActions.includes(action)) return { offered: false, allowed: false, reason: null };
  if (!serverActionable(server, "servers.players.manage")) {
    return {
      offered: true,
      allowed: false,
      reason: server.suspended ? "This server is suspended." : "You don't have permission to manage players.",
    };
  }
  if (OPERATOR_PLAYER_ACTIONS.includes(action) && !serverCan(server, "servers.console.send")) {
    return {
      offered: true,
      allowed: false,
      reason:
        "Operator rights allow any in-game command, so this also needs the Console → Send commands permission.",
    };
  }
  return { offered: true, allowed: true, reason: null };
}

/** Why ban expiry / operator level / bypass can't be set now (null = they can). */
export function stoppedOnlyReason(server: Pick<Server, "state">): string | null {
  return serverStopped(server)
    ? null
    : "Only while the server is stopped: the console commands can't express it. Stop the server to set it.";
}

export interface ActionErrorView {
  tone: "warning" | "danger";
  title: string;
  detail: string | null;
}

function reasonOf(err: unknown): string | null {
  if (!isApiError(err)) return null;
  const d = err.details as { reason?: unknown } | null | undefined;
  return typeof d?.reason === "string" ? d.reason : null;
}

export function describePlayerActionError(err: unknown): ActionErrorView {
  const reason = reasonOf(err);
  if (reason === "no_feedback")
    return {
      tone: "warning",
      title: "Sent, but the server didn't confirm",
      detail:
        "The command reached the console but no confirmation came back within 5 seconds. Check the console to see what happened.",
    };
  if (reason === "not_running")
    return {
      tone: "danger",
      title: "The server isn't running",
      detail: "This only works while the server is running.",
    };
  if (reason === "requires_stopped")
    return {
      tone: "danger",
      title: "Only while the server is stopped",
      detail: "Ban expiry dates and operator levels can only be set while the server is stopped.",
    };
  if (reason === "unsupported_software")
    return { tone: "danger", title: "Not supported by this server software", detail: null };
  if (isApiError(err) && err.code === "RATE_LIMITED") {
    const d = RateLimitedErrorDetails.safeParse(err.details);
    const wait = d.success ? Math.ceil(d.data.retryAfterMs / 1000) : null;
    return {
      tone: "warning",
      title:
        d.success && d.data.upstream === "mojang"
          ? "Mojang is rate-limiting name lookups"
          : "Too many requests",
      detail: wait ? `Try again in ${wait} s.` : "Try again in a moment.",
    };
  }
  if (isApiError(err) && err.code === "NOT_FOUND")
    return { tone: "danger", title: "No Minecraft account with that name", detail: null };
  const d = describeError(err);
  return { tone: "danger", title: d.title, detail: d.detail };
}

export function banExpiry(expiresAt: number | null): string {
  return expiresAt === null ? "Forever" : formatTimestamp(expiresAt, { seconds: false });
}

// ---------------------------------------------------------------------------------------------
// Live join/leave

export interface JoinLeaveEvent {
  name: string;
  uuid: string | null;
  at: number;
  sessionId: string | null;
  reason?: string | null;
}

const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();

/** A player joined: add them to the online list and count (only when the count is known). */
export function applyJoined(o: PlayersOverview, ev: JoinLeaveEvent): PlayersOverview {
  if (o.online.players.some((p) => same(p.name, ev.name))) return o;
  return {
    ...o,
    online: {
      ...o.online,
      players: [...o.online.players, { name: ev.name, uuid: ev.uuid }],
      count: o.online.count === null ? null : o.online.count + 1,
      at: ev.at,
    },
  };
}

export function applyLeft(o: PlayersOverview, ev: JoinLeaveEvent): PlayersOverview {
  const players = o.online.players.filter((p) => !same(p.name, ev.name));
  const removed = players.length !== o.online.players.length;
  return {
    ...o,
    online: {
      ...o.online,
      players,
      count: o.online.count === null ? null : removed ? Math.max(0, o.online.count - 1) : o.online.count,
      at: ev.at,
    },
  };
}

type SessionPages = InfiniteData<Page<PlayerSession>>;

/** Prepend the new session to the (unfiltered) first page. */
export function sessionsJoined(data: SessionPages, ev: JoinLeaveEvent, serverId: string): SessionPages {
  if (!ev.sessionId || data.pages.some((p) => p.items.some((s) => s.id === ev.sessionId))) return data;
  const session: PlayerSession = {
    id: ev.sessionId,
    serverId,
    name: ev.name,
    uuid: ev.uuid,
    joinedAt: ev.at,
    leftAt: null,
    leaveReason: null,
  };
  const [first, ...rest] = data.pages;
  return { ...data, pages: [{ ...first!, items: [session, ...first!.items] }, ...rest] };
}

/** Close the session (by id, else the player's newest open one). */
export function sessionsLeft(data: SessionPages, ev: JoinLeaveEvent): SessionPages {
  let closed = false;
  const pages = data.pages.map((p) => ({
    ...p,
    items: p.items.map((s) => {
      if (closed || s.leftAt !== null) return s;
      if (ev.sessionId ? s.id === ev.sessionId : same(s.name, ev.name)) {
        closed = true;
        return { ...s, leftAt: ev.at, leaveReason: ev.reason ?? null };
      }
      return s;
    }),
  }));
  return closed ? { ...data, pages } : data;
}

/** Player actions that open a dialog (the rest run from their button). */
export type DialogAction = "kick" | "ban" | "ban-ip" | "op" | "whitelist-add";

/** Dialog titles (also used while the dialog's chunk loads). */
export const ACTION_TITLE: Record<DialogAction, string> = {
  kick: "Kick a player",
  ban: "Ban a player",
  "ban-ip": "Ban an IP address",
  op: "Make a player an operator",
  "whitelist-add": "Add to the whitelist",
};

/** Actions that add a name to a list: the name is looked up (UUID + source) before anything is sent. */
export const NEEDS_LOOKUP: ReadonlySet<DialogAction> = new Set<DialogAction>(["ban", "op", "whitelist-add"]);
