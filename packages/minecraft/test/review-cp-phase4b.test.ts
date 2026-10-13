import { describe, expect, it } from "vitest";
import { CatalogError, MojangRateLimiter, TtlCache, lookupMojangProfile, parseCommandFeedback, parseRetryAfter, type CatalogContext, type Fetch } from "../src/index.js";
import { fixture } from "./helpers.js";

/**
 * Regression tests for the Grok review of the control plane Phase 4b
 * (docs/reviews/2026-10-12-control-plane-phase4b.md): #4 (feedback targets) and #8 (Mojang Retry-After + shared limiter).
 */

const lang = JSON.parse(fixture("players/lang-26.3-en_us-commands.json")) as Record<string, string>;
const legacy = Object.fromEntries(
  fixture("players/lang-1.12.2-en_us-commands.lang")
    .split("\n")
    .filter((l) => l.includes("="))
    .map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1)]),
) as Record<string, string>;
const fmt = (s: string, ...args: string[]) => args.reduce((acc, a) => acc.replace("%s", a), s);
const info = (msg: string) => `[19:30:01 INFO]: ${msg}`;

describe("#4 round 2: kick refusals and in-game command output", () => {
  it("26.3 kick refusals are target-less kick failures", () => {
    for (const key of ["commands.kick.owner.failed", "commands.kick.singleplayer.failed"]) {
      expect(parseCommandFeedback(info(lang[key]!))).toEqual({ action: "kick", ok: false, target: null, message: lang[key] });
    }
  });

  it("the op broadcast of a command a player or RCON client ran (chat.type.admin `[%s: %s]`) is not feedback", () => {
    for (const line of [
      "[19:35:40] [Server thread/INFO]: System chat: [Steve: Made Alex a server operator]",
      "[19:35:40 INFO]: System chat: [Rcon: Made Alex a server operator]",
      "[12:00:00 INFO]: [Steve: Opped Alex]",
      `[12:00:00 INFO]: [Steve: ${lang["commands.op.failed"]}]`,
      "[12:00:00 INFO]: [Steve: No player was found]",
    ]) expect(parseCommandFeedback(line), line).toBeNull();
  });
});

describe("#4 command feedback failures carry their target", () => {
  it("1.12.2 failures name the player; 26.3 failures and argument errors name nobody", () => {
    const named: Array<[string, string]> = [
      [fmt(legacy["commands.op.failed"]!, "Alex"), "op"],
      [fmt(legacy["commands.deop.failed"]!, "Alex"), "deop"],
      [fmt(legacy["commands.ban.failed"]!, "Alex"), "ban"],
      [fmt(legacy["commands.unban.failed"]!, "Alex"), "pardon"],
      [fmt(legacy["commands.whitelist.add.failed"]!, "Alex"), "whitelist.add"],
      [fmt(legacy["commands.whitelist.remove.failed"]!, "Alex"), "whitelist.remove"],
    ];
    for (const [msg, action] of named) expect(parseCommandFeedback(info(msg)), msg).toEqual({ action, ok: false, target: "Alex", message: msg });
    const targetless: Array<[string, string]> = [
      [lang["commands.op.failed"]!, "op"],
      [lang["commands.deop.failed"]!, "deop"],
      [lang["commands.ban.failed"]!, "ban"],
      [lang["commands.pardon.failed"]!, "pardon"],
      [lang["commands.whitelist.add.failed"]!, "whitelist.add"],
      [lang["commands.whitelist.remove.failed"]!, "whitelist.remove"],
      [lang["commands.banip.failed"]!, "ban-ip"],
      [lang["commands.banip.invalid"]!, "ban-ip"],
      [lang["commands.pardonip.failed"]!, "pardon-ip"],
      [lang["argument.player.unknown"]!, "player"],
      [lang["argument.entity.notfound.player"]!, "player"],
      [legacy["commands.banip.invalid"]!, "ban-ip"],
      [legacy["commands.unbanip.invalid"]!, "pardon-ip"],
    ];
    for (const [msg, action] of targetless) expect(parseCommandFeedback(info(msg)), msg).toEqual({ action, ok: false, target: null, message: msg });
  });

  it("a failure naming something that is not a player name is not recognised", () => {
    expect(parseCommandFeedback(info("Could not op @a"))).toBeNull();
    expect(parseCommandFeedback(info("Could not add ../x to the whitelist"))).toBeNull();
  });
});

describe("#8 Retry-After parsing", () => {
  const now = Date.parse("2026-10-12T12:00:00Z");
  it("accepts delay-seconds and HTTP-dates, clamps, rejects garbage", () => {
    expect(parseRetryAfter("120", now)).toBe(120_000);
    expect(parseRetryAfter(" 5 ", now)).toBe(5_000);
    expect(parseRetryAfter("0", now)).toBe(1_000);
    expect(parseRetryAfter("999999", now)).toBe(15 * 60_000);
    expect(parseRetryAfter("999999", now, 30_000)).toBe(30_000);
    expect(parseRetryAfter("Mon, 12 Oct 2026 12:02:30 GMT", now)).toBe(150_000);
    expect(parseRetryAfter("Mon, 12 Oct 2026 11:00:00 GMT", now)).toBe(1_000); // in the past
    expect(parseRetryAfter("Tue, 12 Oct 2027 12:00:00 GMT", now)).toBe(15 * 60_000);
    for (const bad of [null, undefined, "", "-5", "soon", "12 Oct 2026", "Mon, 99 Foo 2026 12:00:00 GMT", "1e3", ".5", "Mon, 31 Feb 2026 12:00:00 GMT"]) expect(parseRetryAfter(bad, now), String(bad)).toBeNull();
  });

  it("round 2: decimal seconds round up; RFC 850 and asctime dates are UTC", () => {
    expect(parseRetryAfter("1.5", now)).toBe(2_000);
    expect(parseRetryAfter("0.2", now)).toBe(1_000);
    expect(parseRetryAfter("Monday, 12-Oct-26 12:02:00 GMT", now)).toBe(120_000);
    // asctime has no zone and means UTC (Date.parse would read it as local time).
    expect(parseRetryAfter("Mon Oct 12 12:03:00 2026", now)).toBe(180_000);
    expect(parseRetryAfter("Mon Oct  5 12:00:00 2026", now)).toBe(1_000); // single-digit day, in the past
    expect(parseRetryAfter("Mon Oct 12 12:03:00 2026 GMT", now)).toBeNull();
  });
});

describe("#8 Mojang 429 honours Retry-After; one shared limiter", () => {
  const base = "https://api.mojang.com/users/profiles/minecraft/";
  const NOTCH = fixture("players/mojang-profile-Notch.json");

  function upstream(answer: (url: string) => Response) {
    const calls: string[] = [];
    const fetch: Fetch = async (input) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      calls.push(url);
      return answer(url);
    };
    return { fetch, calls };
  }
  const clock = () => {
    const c = { now: Date.parse("2026-10-12T12:00:00Z"), slept: [] as number[] };
    return { c, opts: { now: () => c.now, sleep: async (ms: number) => void ((c.now += ms), c.slept.push(ms)) } };
  };

  it("uses Retry-After seconds / HTTP-date, falls back to 60 s when absent or invalid (no limiter)", async () => {
    const now = () => Date.parse("2026-10-12T12:00:00Z");
    for (const [header, expected] of [
      ["30", 30_000],
      ["Mon, 12 Oct 2026 12:05:00 GMT", 300_000],
      ["86400", 15 * 60_000],
      ["nonsense", 60_000],
      [null, 60_000],
    ] as const) {
      const up = upstream(() => new Response("", { status: 429, headers: header === null ? {} : { "retry-after": header } }));
      await expect(lookupMojangProfile({ fetch: up.fetch }, "Busy", { now }), String(header)).rejects.toMatchObject({ code: "RATE_LIMITED", retryAfterMs: expected });
    }
  });

  it("after a 429 the shared limiter refuses every caller until Retry-After passed, without touching the network", async () => {
    const { c, opts } = clock();
    const limiter = new MojangRateLimiter(opts);
    let busy = true;
    const up = upstream(() => (busy ? new Response("", { status: 429, headers: { "retry-after": "45" } }) : new Response(NOTCH, { status: 200 })));
    const a: CatalogContext = { fetch: up.fetch };
    const b: CatalogContext = { fetch: up.fetch }; // a second caller (e.g. lookup vs. whitelist-add) with its own context
    await expect(lookupMojangProfile(a, "Notch", { limiter })).rejects.toMatchObject({ code: "RATE_LIMITED", retryAfterMs: 45_000 });
    expect(up.calls).toEqual([`${base}Notch`]);
    busy = false;
    c.now += 10_000;
    const refused = await lookupMojangProfile(b, "Notch", { limiter }).catch((e: unknown) => e);
    expect(refused).toBeInstanceOf(CatalogError);
    expect(refused).toMatchObject({ code: "RATE_LIMITED", retryAfterMs: 35_000 });
    expect(up.calls).toHaveLength(1);
    expect(limiter.blockedForMs).toBe(35_000);
    // Within maxWaitMs of the end: the caller waits instead of failing.
    c.now += 33_500;
    expect(await lookupMojangProfile(b, "Notch", { limiter })).toMatchObject({ name: "Notch", source: "mojang" });
    expect(c.slept).toEqual([1_500]);
    expect(up.calls).toHaveLength(2);
  });

  it("round 2: a Retry-After recorded while a caller sleeps extends its wait; rateLimited returns the effective block", async () => {
    const { c, opts } = clock();
    const t0 = c.now;
    let first = true;
    const limiter: MojangRateLimiter = new MojangRateLimiter({
      ...opts,
      maxWaitMs: 5_000,
      sleep: async (ms) => {
        if (first) {
          first = false;
          c.now += 1_000;
          // Another caller's response: 429 with Retry-After 4 s, recorded mid-sleep.
          expect(limiter.rateLimited("4")).toBe(4_000);
          c.now += ms - 1_000;
        } else c.now += ms;
        c.slept.push(ms);
      },
    });
    expect(limiter.rateLimited("2")).toBe(2_000);
    expect(limiter.rateLimited("1")).toBe(2_000); // the longer block stays
    await limiter.acquire("u");
    expect(c.slept).toEqual([2_000, 3_000]);
    expect(c.now).toBe(t0 + 5_000);
    expect(limiter.blockedForMs).toBe(0);
  });

  it("round 2: a window sleep that ends early is re-checked before the permit is taken", async () => {
    const { c } = clock();
    let calls = 0;
    const limiter = new MojangRateLimiter({
      now: () => c.now,
      maxRequests: 1,
      windowMs: 1_000,
      sleep: async (ms) => {
        c.slept.push(ms);
        c.now += calls++ === 0 ? ms / 2 : ms; // the first wake-up comes too early
      },
    });
    await limiter.acquire("u");
    const t1 = c.now;
    await limiter.acquire("u");
    expect(c.slept).toEqual([1_000, 500]);
    expect(c.now).toBe(t1 + 1_000);
  });

  it("serialises callers in a sliding window and never refuses while quota remains; cache hits take no permit", async () => {
    const { c, opts } = clock();
    const limiter = new MojangRateLimiter({ ...opts, maxRequests: 2, windowMs: 1_000, maxWaitMs: 2_000 });
    const up = upstream(() => new Response(NOTCH, { status: 200 }));
    const ctx: CatalogContext = { fetch: up.fetch };
    await Promise.all([lookupMojangProfile(ctx, "Notch", { limiter }), lookupMojangProfile(ctx, "Notch", { limiter }), lookupMojangProfile(ctx, "Notch", { limiter })]);
    expect(up.calls).toHaveLength(3);
    expect(c.slept).toEqual([1_000]); // the third waited for the window to slide
    const tight = new MojangRateLimiter({ ...opts, maxRequests: 1, windowMs: 60_000, maxWaitMs: 2_000 });
    await lookupMojangProfile(ctx, "Notch", { limiter: tight });
    await expect(lookupMojangProfile(ctx, "Notch", { limiter: tight })).rejects.toMatchObject({ code: "RATE_LIMITED", retryAfterMs: 60_000 });
    const cached: CatalogContext = { fetch: up.fetch, cache: new TtlCache<string, string>({ defaultTtlMs: 60_000, maxEntries: 10 }) };
    const one = new MojangRateLimiter({ ...opts, maxRequests: 1, windowMs: 60_000, maxWaitMs: 0 });
    for (let i = 0; i < 3; i++) await lookupMojangProfile(cached, "Notch", { limiter: one });
  });
});
