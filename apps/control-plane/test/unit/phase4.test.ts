import { describe, expect, it } from "vitest";
import { ipAllowed } from "../../src/apikeys/service.js";
import { isSaveConfirmation } from "../../src/backups/jobs.js";
import { MIN_PART_SIZE, partPlan } from "../../src/backups/storage.js";
import { cronError, nextRuns, validTimezone } from "../../src/schedules/cron.js";
import { withLockRelease } from "../../src/servers/jobs.js";
import type { JobDefinition } from "../../src/jobs/types.js";

describe("Minecraft save confirmation", () => {
  it("matches vanilla/Paper/Forge wording, not chat or other lines", () => {
    expect(isSaveConfirmation("[12:00:00] [Server thread/INFO]: Saved the game")).toBe(true);
    expect(isSaveConfirmation("[12:00:00 INFO]: Saved the game")).toBe(true);
    expect(isSaveConfirmation("[04:01:48] [Server thread/INFO] [minecraft/MinecraftServer]: Saved the game")).toBe(true);
    expect(isSaveConfirmation("[12:00:00] [Server thread/INFO]: Saved the world")).toBe(true);
    expect(isSaveConfirmation("[12:00:00] [Server thread/INFO]: Saving the game (this may take a moment!)")).toBe(false);
    expect(isSaveConfirmation("[12:00:00] [Server thread/INFO]: <Steve> Saved the game")).toBe(false);
    expect(isSaveConfirmation("[12:00:00 INFO]: [Not Secure] <Steve> Saved the game")).toBe(false);
    expect(isSaveConfirmation("Automatic saving is now disabled")).toBe(false);
  });

  it("matches 26.x 'System chat:' feedback captured on the test node (Paper + vanilla), not chat", () => {
    // Real lines captured 2026-10-12 (packages/minecraft/test/fixtures/console/captured-26.3.json).
    expect(isSaveConfirmation("[19:33:07 INFO]: System chat: Saved the game")).toBe(true);
    expect(isSaveConfirmation("[19:35:40] [Server thread/INFO]: System chat: Saved the game")).toBe(true);
    expect(isSaveConfirmation("[19:35:31 INFO]: System chat: Saving the game (this may take a moment!)")).toBe(false);
    expect(isSaveConfirmation("[19:35:30 INFO]: System chat: Automatic saving is now disabled")).toBe(false);
    expect(isSaveConfirmation("[19:35:30 INFO]: <Steve> System chat: Saved the game")).toBe(false);
  });
});

describe("S3 multipart plan", () => {
  it("uses parts of at least 64 MiB and never more than 10 000", () => {
    expect(partPlan(1)).toEqual({ partSize: MIN_PART_SIZE, count: 1 });
    expect(partPlan(0)).toEqual({ partSize: MIN_PART_SIZE, count: 1 });
    expect(partPlan(MIN_PART_SIZE + 1)).toEqual({ partSize: MIN_PART_SIZE, count: 2 });
    const big = partPlan(512 * 1024 ** 3);
    expect(big.count).toBeLessThanOrEqual(10_000);
    expect(big.partSize % (1024 ** 2)).toBe(0);
    const huge = partPlan(1024 * 1024 ** 3);
    expect(huge.count).toBeLessThanOrEqual(10_000);
    expect(huge.partSize).toBeGreaterThan(MIN_PART_SIZE);
  });
});

describe("API key IP allowlists", () => {
  it("matches IPv4/IPv6 CIDRs and IPv4-mapped addresses", () => {
    expect(ipAllowed("10.1.2.3", [])).toBe(true);
    expect(ipAllowed("10.1.2.3", ["10.0.0.0/8"])).toBe(true);
    expect(ipAllowed("11.1.2.3", ["10.0.0.0/8"])).toBe(false);
    expect(ipAllowed("::ffff:10.1.2.3", ["10.0.0.0/8"])).toBe(true);
    expect(ipAllowed("192.168.1.5", ["192.168.1.5"])).toBe(true);
    expect(ipAllowed("2001:db8::1", ["2001:db8::/32"])).toBe(true);
    expect(ipAllowed("2001:db9::1", ["2001:db8::/32"])).toBe(false);
    expect(ipAllowed("not-an-ip", ["0.0.0.0/0"])).toBe(false);
  });
});

describe("cron helpers", () => {
  it("compute next runs in the schedule's time zone (DST-aware) and validate", () => {
    const cron = { minute: "30", hour: "2", dayOfMonth: "*", month: "*", dayOfWeek: "*" };
    // Europe/Berlin leaves DST on 2026-10-25: 02:30 local is 00:30Z before, 01:30Z after.
    const runs = nextRuns(cron, "Europe/Berlin", 3, new Date("2026-10-23T12:00:00Z")).map((d) => d.toISOString());
    expect(runs[0]).toBe("2026-10-24T00:30:00.000Z");
    expect(runs[2]).toBe("2026-10-26T01:30:00.000Z");
    expect(cronError(cron, "UTC")).toBeNull();
    expect(cronError({ ...cron, minute: "75" }, "UTC")).toMatch(/minute/);
    expect(validTimezone("America/New_York")).toBe(true);
    expect(validTimezone("Mars/Olympus")).toBe(false);
  });
});

describe("server job operation lock (H9)", () => {
  it("is released even when a finalize hook throws, and the error still surfaces", async () => {
    const ended: string[] = [];
    const state = { end: async (serverId: string, jobId: string) => void ended.push(`${serverId}:${jobId}`) };
    const def = withLockRelease(
      {
        type: "test.finalize-throws",
        steps: [],
        finalize: async () => {
          throw new Error("finalize failed");
        },
      } as unknown as JobDefinition<{ serverId: string }>,
      state as never,
    );
    const f = { jobId: "job-1", input: { serverId: "server-1" }, status: "failed", error: null, state: {}, log: async () => undefined };
    await expect(def.finalize!(f as never)).rejects.toThrow("finalize failed");
    expect(ended).toEqual(["server-1:job-1"]);
    // Without a finalize hook nothing is wrapped (the runner's default path applies).
    const bare = { type: "test.bare", steps: [] } as unknown as JobDefinition<{ serverId: string }>;
    expect(withLockRelease(bare, state as never)).toBe(bare);
  });
});
