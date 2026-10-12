import type { InfiniteData } from "@tanstack/react-query";
import { describe, expect, it } from "vitest";
import {
  BACKUP_JOB_ERROR_CODES,
  EXTENSIONS_READ_PERMISSION,
  SERVER_JOB_ERROR_CODES,
} from "@blockforge/contracts";
import type { Page, PlayerSession, PlayersOverview } from "@blockforge/contracts";
import { ApiError } from "@/lib/api/errors";
import { describeJobError } from "@/lib/job-errors";
import { SERVER_TABS, visibleServerTabs } from "@/lib/server-permissions";
import { SERVER_ID, makeServer } from "@/test/fixtures";
import {
  checkUploadFile,
  extensionNames,
  groupPlanWarnings,
  historyChange,
  installAction,
  installRequest,
  planChangedFrom,
  safeCdnIcon,
  safeHttpsLink,
} from "@/features/servers/extensions/extension-model";
import {
  actionGate,
  applyJoined,
  applyLeft,
  describePlayerActionError,
  sessionsJoined,
  sessionsLeft,
  stoppedOnlyReason,
} from "@/features/servers/players/player-model";

describe("Plugins & mods tab permission", () => {
  it("is the contract's read permission", () => {
    expect(SERVER_TABS.find((t) => t.id === "extensions")?.anyOf).toEqual([EXTENSIONS_READ_PERMISSION]);
  });
});

describe("tab gating for Phase 4b", () => {
  it("shows Plugins & mods only for software that loads them, Players only for Minecraft", () => {
    const tabs = (o: Parameters<typeof makeServer>[0]) => visibleServerTabs(makeServer(o)).map((t) => t.id);
    expect(tabs({ software: "paper" })).toEqual(expect.arrayContaining(["extensions", "players"]));
    expect(tabs({ software: "vanilla" })).not.toContain("extensions");
    expect(tabs({ software: null, game: "other" })).not.toContain("extensions");
    expect(tabs({ software: null, game: "other" })).not.toContain("players");
    expect(tabs({ myPermissions: ["servers.view", "servers.extensions.view"] })).toEqual(["extensions"]);
  });
});

describe("job error labels", () => {
  it("describes backup and server job codes", () => {
    for (const [code, text] of Object.entries({ ...SERVER_JOB_ERROR_CODES, ...BACKUP_JOB_ERROR_CODES }))
      expect(describeJobError(code).description).toBe(text);
    expect(describeJobError("SAVE_FAILED").hint).toMatch(/disk space/);
    expect(describeJobError("hasOwnProperty").description).toBeNull();
  });
});

describe("extension helpers", () => {
  it("only allows https links and Modrinth CDN icons", () => {
    expect(safeHttpsLink("https://github.com/x")).toBe("https://github.com/x");
    for (const bad of ["http://x.test", "javascript:alert(1)", "https://u:p@x.test", "//x.test", null, ""])
      expect(safeHttpsLink(bad)).toBeNull();
    expect(safeCdnIcon("https://cdn.modrinth.com/data/a/icon.png")).toBe(
      "https://cdn.modrinth.com/data/a/icon.png",
    );
    expect(safeCdnIcon("https://evil.test/icon.png")).toBeNull();
    expect(safeCdnIcon("https://cdn.modrinth.com:8443/icon.png")).toBeNull();
  });
  it("names multi-mod jars by their metadata, else the Modrinth title, else the file", () => {
    const meta = (name: string) => ({ name }) as never;
    expect(
      extensionNames({ metadata: [meta("A"), meta("B"), meta("A")], modrinth: null, filename: "x.jar" }),
    ).toEqual(["A", "B"]);
    expect(extensionNames({ metadata: [], modrinth: { title: "T" } as never, filename: "x.jar" })).toEqual([
      "T",
    ]);
    expect(extensionNames({ metadata: [], modrinth: null, filename: "x.jar" })).toEqual(["x.jar"]);
  });
  it("builds install requests and per-body idempotency actions", () => {
    const plan = {
      files: [
        { projectId: "AAAA", versionId: "v1", action: "install" },
        { projectId: "BBBB", versionId: "v2", action: "replace" },
      ],
    } as never;
    const body = installRequest({ project: "lithium", includeOptional: [], allowPrerelease: false }, plan);
    expect(body.expect).toEqual([
      { projectId: "AAAA", versionId: "v1", action: "install" },
      { projectId: "BBBB", versionId: "v2", action: "replace" },
    ]);
    expect(installAction(body)).toBe(installAction({ ...body, expect: [...body.expect].reverse() }));
    expect(installAction(body)).not.toBe(installAction({ ...body, allowPrerelease: true }));
    expect(installAction(body)).not.toBe(installAction({ ...body, expect: body.expect.slice(1) }));
  });
  it("recognises a 409 plan_changed and nothing else", () => {
    const err = (status: number, details: unknown) =>
      new ApiError({ code: "CONFLICT", message: "x", status, details });
    const parse = (v: unknown) => (v ? ({ fresh: true } as never) : null);
    expect(planChangedFrom(err(409, { reason: "plan_changed", plan: {} }), parse)).toEqual({ fresh: true });
    expect(planChangedFrom(err(409, { reason: "in_progress" }), parse)).toBeNull();
    expect(planChangedFrom(err(422, { reason: "plan_changed", plan: {} }), parse)).toBeNull();
  });
  it("groups plan warnings by level and checks upload files", () => {
    const w = (level: "info" | "warning" | "error") =>
      ({ code: "CLIENT_ONLY", level, message: level, projectId: null, versionId: null }) as const;
    const g = groupPlanWarnings([w("error"), w("info"), w("warning"), w("error")]);
    expect([g.error.length, g.warning.length, g.info.length]).toEqual([2, 1, 1]);
    expect(checkUploadFile({ name: "Essentials.jar", size: 1000 })).toBeNull();
    expect(checkUploadFile({ name: "notes.txt", size: 10 })).toMatch(/\.jar/);
    expect(checkUploadFile({ name: "CON.jar", size: 10 })).toMatch(/Rename/);
    expect(checkUploadFile({ name: "big.jar", size: 300 * 1024 ** 2 })).toMatch(/larger/);
    expect(historyChange({ from: null, to: { versionNumber: "1.2", path: "plugins/a.jar" } as never })).toBe(
      "— → 1.2",
    );
    expect(historyChange({ from: { versionNumber: null, path: "plugins/a.jar" } as never, to: null })).toBe(
      "a.jar → —",
    );
  });
});

describe("player rules", () => {
  const overview = (actions: string[]): PlayersOverview =>
    ({
      online: {
        count: 1,
        max: 20,
        players: [{ name: "Alex", uuid: null }],
        skipped: 0,
        source: "list",
        at: 1,
      },
      availableActions: actions,
    }) as unknown as PlayersOverview;
  it("offers only available actions; op also needs console send", () => {
    const manager = makeServer({
      myPermissions: ["servers.view", "servers.players.view", "servers.players.manage"],
    });
    expect(actionGate(manager, overview(["kick"]), "ban").offered).toBe(false);
    expect(actionGate(manager, overview(["kick"]), "kick")).toEqual({
      offered: true,
      allowed: true,
      reason: null,
    });
    expect(actionGate(manager, overview(["op"]), "op")).toMatchObject({
      allowed: false,
      reason: expect.stringMatching(/Send commands/),
    });
    const viewer = makeServer({ myPermissions: ["servers.view", "servers.players.view"] });
    expect(actionGate(viewer, overview(["kick"]), "kick")).toMatchObject({ offered: true, allowed: false });
    expect(stoppedOnlyReason(makeServer({ state: "running" }))).toMatch(/stopped/);
    expect(stoppedOnlyReason(makeServer({ state: "stopped" }))).toBeNull();
  });
  it("explains action errors", () => {
    const e = (code: string, status: number, details?: unknown) =>
      new ApiError({ code: code as never, message: "m", status, details });
    expect(
      describePlayerActionError(e("UPSTREAM_ERROR", 504, { reason: "no_feedback", sent: true })).title,
    ).toBe("Sent, but the server didn't confirm");
    expect(describePlayerActionError(e("INVALID_STATE", 409, { reason: "requires_stopped" })).title).toMatch(
      /stopped/,
    );
    expect(
      describePlayerActionError(e("RATE_LIMITED", 429, { retryAfterMs: 4200, upstream: "mojang" })),
    ).toMatchObject({
      title: "Mojang is rate-limiting name lookups",
      detail: "Try again in 5 s.",
    });
    expect(describePlayerActionError(e("NOT_FOUND", 404)).title).toMatch(/No Minecraft account/);
  });
  it("patches the online list and sessions from join/leave events", () => {
    const o = overview([]);
    const joined = applyJoined(o, { name: "Steve", uuid: null, at: 5, sessionId: "s1" });
    expect(joined.online.players.map((p) => p.name)).toEqual(["Alex", "Steve"]);
    expect(joined.online.count).toBe(2);
    expect(applyJoined(joined, { name: "steve", uuid: null, at: 6, sessionId: null })).toBe(joined);
    const left = applyLeft(joined, { name: "ALEX", uuid: null, at: 7, sessionId: null });
    expect(left.online.players.map((p) => p.name)).toEqual(["Steve"]);
    expect(left.online.count).toBe(1);
    const unknown = { ...o, online: { ...o.online, count: null } };
    expect(
      applyJoined(unknown, { name: "Steve", uuid: null, at: 5, sessionId: null }).online.count,
    ).toBeNull();

    const pages: InfiniteData<Page<PlayerSession>> = {
      pages: [{ items: [], nextCursor: null }],
      pageParams: [null],
    };
    const s1 = "d0000000-0000-4000-8000-000000000001";
    const opened = sessionsJoined(pages, { name: "Steve", uuid: null, at: 5, sessionId: s1 }, SERVER_ID);
    expect(opened.pages[0]!.items[0]).toMatchObject({ id: s1, name: "Steve", leftAt: null });
    const closed = sessionsLeft(opened, {
      name: "Steve",
      uuid: null,
      at: 9,
      sessionId: s1,
      reason: "Disconnected",
    });
    expect(closed.pages[0]!.items[0]).toMatchObject({ leftAt: 9, leaveReason: "Disconnected" });
  });
});
