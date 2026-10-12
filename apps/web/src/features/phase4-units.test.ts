import { QueryClient } from "@tanstack/react-query";
import { describe, expect, it } from "vitest";
import { API_KEY_FORBIDDEN_PERMISSIONS, SERVER_OWNER_PERMISSIONS } from "@blockforge/contracts";
import type { Backup, Schedule } from "@blockforge/contracts";
import { SERVER_ID, USER_ID, makeBackup, makeMe, makeSchedule, makeServer } from "@/test/fixtures";
import { CRON_PRESETS, describeCron, formatInZone, isValidTimeZone, presetFor } from "@/lib/cron";
import {
  applyBackupEvent,
  applyScheduleEvent,
  removeBackupFromCache,
  removeScheduleFromCache,
} from "@/lib/phase4-cache";
import { qk } from "@/lib/query-keys";
import {
  backupsUsed,
  canRotate,
  createdByLabel,
  isSafeDownloadUrl,
} from "@/features/servers/tabs/backups-tab";
import {
  MAX_TASKS,
  draftFromSchedule,
  draftToRequest,
  moveTask,
  newTask,
  reorderTask,
  scheduleToRequest,
  taskBlockedReason,
} from "@/features/servers/tabs/schedule-model";
import { keyPermissionOptions, parseAllowedIps, usageExample } from "@/features/settings/api-keys";
import { formFromSettings, storageRequest } from "@/features/settings/backup-storage";

const cron = (minute: string, hour: string, dayOfMonth: string, month: string, dayOfWeek: string) => ({
  minute,
  hour,
  dayOfMonth,
  month,
  dayOfWeek,
});

describe("cron in words", () => {
  it("describes the presets and common shapes", () => {
    expect(CRON_PRESETS.map((p) => describeCron(p.cron))).toEqual([
      "Every 15 minutes",
      "Every hour at :00",
      "Every day at 04:00",
      "Every Sunday at 04:00",
    ]);
    expect(describeCron(cron("*", "*", "*", "*", "*"))).toBe("Every minute");
    expect(describeCron(cron("30", "*/6", "*", "*", "*"))).toBe("Every 6 hours at :30");
    expect(describeCron(cron("5", "3", "*", "*", "1-5"))).toBe("Every weekday (Mon–Fri) at 03:05");
    expect(describeCron(cron("0", "12", "*", "*", "MON,FRI"))).toBe("Every Monday and Friday at 12:00");
    expect(describeCron(cron("0", "0", "1", "*", "*"))).toBe("On day 1 of every month at 00:00");
    expect(describeCron(cron("0", "0", "*", "*", "7"))).toBe("Every Sunday at 00:00");
  });
  it("returns null instead of guessing", () => {
    expect(describeCron(cron("0", "4", "1", "*", "1"))).toBeNull();
    expect(describeCron(cron("0", "4", "L", "*", "*"))).toBeNull();
    expect(describeCron(cron("0", "4", "*", "*", "8"))).toBeNull();
    expect(describeCron(cron("0-10", "4", "*", "*", "*"))).toBeNull();
  });
  it("recognises presets and formats times in a zone", () => {
    expect(presetFor(cron("0", "4", "*", "*", "*"))).toBe("daily");
    expect(presetFor(cron("1", "4", "*", "*", "*"))).toBeNull();
    expect(isValidTimeZone("Europe/Berlin")).toBe(true);
    expect(isValidTimeZone("Mars/Base")).toBe(false);
    expect(formatInZone(Date.UTC(2026, 9, 12, 2, 0), "Europe/Berlin")).toMatch(/^2026-10-12 04:00 /);
    expect(formatInZone(Date.UTC(2026, 9, 12, 2, 0), "UTC")).toBe("2026-10-12 02:00 UTC");
  });
});

describe("schedule editor model", () => {
  const server = makeServer({ timezone: "Europe/Berlin" });

  it("round-trips a schedule into a valid request", () => {
    const s = makeSchedule();
    const { request, errors } = draftToRequest(draftFromSchedule(s, "UTC"));
    expect(errors).toEqual({});
    expect(request).toMatchObject({
      name: "Nightly restart",
      timezone: "Europe/Berlin",
      tasks: [
        { action: "command", command: "say Restarting in 5 minutes", continueOnFailure: true },
        { action: "power", power: "restart", offsetSeconds: 300 },
      ],
    });
  });

  it("starts new schedules in the server's zone with one task", () => {
    const d = draftFromSchedule(null, server.timezone);
    expect(d.timezone).toBe("Europe/Berlin");
    expect(d.tasks).toHaveLength(1);
  });

  it("reports field errors by path", () => {
    const d = draftFromSchedule(null, "Nowhere/Zone");
    d.name = " ";
    d.cron = { ...d.cron, minute: "every minute" };
    d.tasks = [
      { ...newTask("command"), command: "" },
      { ...newTask("power"), offsetSeconds: "901" },
    ];
    const { request, errors } = draftToRequest(d);
    expect(request).toBeNull();
    expect(Object.keys(errors).sort()).toEqual(
      ["cron.minute", "name", "tasks.0.command", "tasks.1.offsetSeconds", "timezone"].sort(),
    );
    const many = draftFromSchedule(null, "UTC");
    many.name = "x";
    many.tasks = Array.from({ length: MAX_TASKS + 1 }, () => ({ ...newTask("command"), command: "list" }));
    expect(draftToRequest(many).errors.tasks).toMatch(/20/);
    many.tasks = [];
    expect(draftToRequest(many).errors.tasks).toMatch(/at least one/);
  });

  it("sends backup tasks with their ignore patterns as a list", () => {
    const d = draftFromSchedule(null, "UTC");
    d.name = "Backup";
    d.tasks = [{ ...newTask("backup"), ignore: "*.log\n\n logs/ ", rotate: false }];
    expect(draftToRequest(d).request?.tasks[0]).toEqual({
      action: "backup",
      ignore: ["*.log", "logs/"],
      rotate: false,
      offsetSeconds: 0,
      continueOnFailure: false,
    });
  });

  it("reorders tasks with buttons and drag and drop", () => {
    expect(moveTask(["a", "b", "c"], 0, 1)).toEqual(["b", "a", "c"]);
    expect(moveTask(["a", "b", "c"], 0, -1)).toEqual(["a", "b", "c"]);
    expect(moveTask(["a", "b", "c"], 2, 1)).toEqual(["a", "b", "c"]);
    expect(reorderTask(["a", "b", "c"], 2, 0)).toEqual(["c", "a", "b"]);
    expect(reorderTask(["a", "b", "c"], 0, 2)).toEqual(["b", "c", "a"]);
  });

  it("explains task types the user cannot use", () => {
    const consoleOnly = makeServer({
      myPermissions: ["servers.view", "schedules.manage", "servers.console.send"],
    });
    expect(taskBlockedReason(consoleOnly, "command")).toBeNull();
    expect(taskBlockedReason(consoleOnly, "power")).toMatch(/servers\.control/);
    expect(taskBlockedReason(consoleOnly, "backup")).toMatch(/servers\.backups\.create/);
    expect(taskBlockedReason(makeServer({ backupLimit: 0 }), "backup")).toMatch(/disabled/);
  });

  it("the enabled toggle re-sends the schedule unchanged otherwise", () => {
    const s = makeSchedule();
    expect(scheduleToRequest(s, { enabled: false })).toEqual({
      name: s.name,
      cron: s.cron,
      timezone: s.timezone,
      enabled: false,
      onlyWhenOnline: false,
      tasks: s.tasks,
    });
  });
});

describe("backups", () => {
  it("counts slots and rotation candidates", () => {
    const list = [
      makeBackup({ id: "a0000000-0000-4000-8000-000000000001" }),
      makeBackup({ id: "a0000000-0000-4000-8000-000000000002", locked: true }),
      makeBackup({ id: "a0000000-0000-4000-8000-000000000003", status: "failed", error: "disk full" }),
    ];
    // BACKUP_COUNTED_STATUSES: in-progress backups hold a slot, failed ones don't.
    expect(backupsUsed(list)).toBe(2);
    expect(
      backupsUsed([...list, makeBackup({ id: "a0000000-0000-4000-8000-000000000004", status: "uploading" })]),
    ).toBe(3);
    expect(canRotate(list)).toBe(true);
    expect(canRotate([list[1]!, list[2]!])).toBe(false);
  });

  it("only follows same-origin or HTTPS download URLs", () => {
    const origin = "https://panel.example.test";
    expect(isSafeDownloadUrl("/api/v1/transfers/abc", origin)).toBe(true);
    expect(isSafeDownloadUrl("https://bucket.s3.example.com/x?X-Amz-Signature=1", origin)).toBe(true);
    expect(isSafeDownloadUrl("http://bucket.example.com/x", origin)).toBe(false);
    expect(isSafeDownloadUrl("javascript:alert(1)", origin)).toBe(false);
    expect(isSafeDownloadUrl("data:text/html,<b>x</b>", origin)).toBe(false);
  });

  it("names who created a backup", () => {
    const me = makeMe();
    expect(createdByLabel(makeBackup({ createdBy: USER_ID }), me)).toBe("You");
    const other = "44444444-4444-4444-8444-444444444444";
    expect(createdByLabel(makeBackup({ createdBy: other, createdByName: "alex" }), me)).toBe("alex");
    expect(createdByLabel(makeBackup({ createdBy: other, createdByName: null }), me)).toBe("A deleted user");
    expect(createdByLabel(makeBackup({ createdBy: null, createdByName: null }), me)).toBe("System");
    const scheduled = makeBackup({ createdBy: null, createdByName: null, scheduleId: makeSchedule().id });
    expect(createdByLabel(scheduled, me, [makeSchedule()])).toBe("Schedule “Nightly restart”");
    expect(createdByLabel(scheduled, me)).toBe("A schedule");
  });

  it("live events update cached lists only", () => {
    const qc = new QueryClient();
    applyBackupEvent(qc, makeBackup());
    expect(qc.getQueryData(qk.server(SERVER_ID).backups)).toBeUndefined();
    const older = makeBackup({ id: "a0000000-0000-4000-8000-000000000009", createdAt: 1 });
    qc.setQueryData<Backup[]>(qk.server(SERVER_ID).backups, [older]);
    applyBackupEvent(qc, makeBackup({ status: "running" }));
    applyBackupEvent(qc, makeBackup({ status: "completed", sizeBytes: 42 }));
    const list = qc.getQueryData<Backup[]>(qk.server(SERVER_ID).backups)!;
    expect(list.map((b) => [b.id, b.status, b.sizeBytes])).toEqual([
      [makeBackup().id, "completed", 42],
      [older.id, "completed", older.sizeBytes],
    ]);
    qc.setQueryData<Schedule[]>(qk.server(SERVER_ID).schedules, [makeSchedule()]);
    applyScheduleEvent(qc, makeSchedule({ running: true }));
    expect(qc.getQueryData<Schedule[]>(qk.server(SERVER_ID).schedules)![0]!.running).toBe(true);
    removeBackupFromCache(qc, SERVER_ID, older.id);
    removeScheduleFromCache(qc, SERVER_ID, makeSchedule().id);
    expect(qc.getQueryData<Backup[]>(qk.server(SERVER_ID).backups)!.map((b) => b.id)).toEqual([
      makeBackup().id,
    ]);
    expect(qc.getQueryData<Schedule[]>(qk.server(SERVER_ID).schedules)).toEqual([]);
  });
});

describe("API keys", () => {
  it("offers the user's own permissions, never the forbidden ones", () => {
    const me = makeMe({ permissions: ["settings.manage", "users.manage", "nodes.view", "monitoring.view"] });
    const opts = keyPermissionOptions({
      ...me,
      scopedPermissions: [{ scopeType: "node", scopeId: makeServer().nodeId, permissions: ["nodes.manage"] }],
    });
    const perms = opts.map((o) => o.permission);
    for (const f of API_KEY_FORBIDDEN_PERMISSIONS) expect(perms).not.toContain(f);
    expect(opts.find((o) => o.permission === "nodes.view")?.where).toBe("global");
    expect(opts.find((o) => o.permission === "nodes.manage")?.where).toBe("scoped");
    // Owners/server users act through per-server permissions.
    expect(opts.find((o) => o.permission === "servers.control")?.where).toBe("servers");
    expect(perms).not.toContain("nodes.enroll");
    expect(perms).toEqual([...perms].sort());
    expect(perms.length).toBeGreaterThanOrEqual(SERVER_OWNER_PERMISSIONS.length);
  });
  it("validates IP and CIDR lines", () => {
    expect(parseAllowedIps("203.0.113.7\n\n10.0.0.0/8\n2001:db8::/32")).toEqual({
      ips: ["203.0.113.7", "10.0.0.0/8", "2001:db8::/32"],
      invalid: [],
    });
    expect(parseAllowedIps("example.com\n1.2.3.4/x").invalid).toEqual(["example.com", "1.2.3.4/x"]);
  });
  it("shows a bearer-token usage example", () => {
    expect(usageExample("bfk_x", "https://panel.example.test")).toBe(
      'curl -H "Authorization: Bearer bfk_x" https://panel.example.test/api/v1/servers',
    );
  });
});

describe("backup storage form", () => {
  const s3 = {
    type: "s3" as const,
    endpoint: "https://s3.example.test",
    region: "eu-central-1",
    bucket: "bf-backups",
    prefix: "blockforge/",
    forcePathStyle: true,
    accessKeyId: "AKIA123",
  };
  it("requires the secret only when S3 is new, and never echoes it", () => {
    const form = formFromSettings(s3);
    expect(form.secretAccessKey).toBe("");
    expect(storageRequest(form, "s3")).toEqual({ body: s3, errors: {} });
    expect(storageRequest(form, "local").errors.secretAccessKey).toBeTruthy();
    expect(storageRequest({ ...form, secretAccessKey: "  s3cr3t " }, "local").body).toEqual({
      ...s3,
      secretAccessKey: "s3cr3t",
    });
  });
  it("rejects plain-HTTP endpoints and short bucket names", () => {
    const { body, errors } = storageRequest(
      { ...formFromSettings(s3), endpoint: "http://s3.example.test", bucket: "x" },
      "s3",
    );
    expect(body).toBeNull();
    expect(Object.keys(errors).sort()).toEqual(["bucket", "endpoint"]);
    expect(storageRequest(formFromSettings({ type: "local" }), "s3")).toEqual({
      body: { type: "local" },
      errors: {},
    });
  });
});
