import { describe, expect, it } from "vitest";
import { discordPayload, validateDiscordUrl } from "../../src/notifications/adapters.js";
import { safePostJson, type RawPost } from "../../src/notifications/http.js";
import { expandV6, isBlockedAddress, SsrfError, validateOutboundUrl, type LookupFn } from "../../src/notifications/ssrf.js";

const resolveTo =
  (...addresses: string[]): LookupFn =>
  async () =>
    addresses.map((address) => ({ address, family: address.includes(":") ? 6 : 4 }));

describe("address classification", () => {
  it.each([
    "127.0.0.1",
    "127.255.0.9",
    "10.1.2.3",
    "172.16.0.1",
    "172.31.255.255",
    "192.168.1.1",
    "169.254.169.254",
    "100.64.0.1",
    "100.127.255.255",
    "0.0.0.0",
    "224.0.0.1",
    "255.255.255.255",
    "198.18.0.1",
    "::1",
    "::",
    "fe80::1",
    "fc00::1",
    "fd00:ec2::254",
    "ff02::1",
    "::ffff:127.0.0.1",
    "::ffff:7f00:1",
    "::ffff:169.254.169.254",
    "64:ff9b::a9fe:a9fe",
    "64:ff9b:1::a00:1",
    "64:ff9b:1:abcd::1",
    "2002:7f00:1::",
    "2001:db8::1",
    "not-an-ip",
  ])("blocks %s", (ip) => {
    expect(isBlockedAddress(ip)).toBe(true);
  });

  it.each(["93.184.216.34", "1.1.1.1", "172.32.0.1", "100.128.0.1", "2606:4700:4700::1111", "::ffff:8.8.8.8", "64:ff9b::808:808"])(
    "allows public %s",
    (ip) => {
      expect(isBlockedAddress(ip)).toBe(false);
    },
  );

  it("expands IPv6 forms", () => {
    expect(expandV6("::1")).toEqual([0, 0, 0, 0, 0, 0, 0, 1]);
    expect(expandV6("::ffff:1.2.3.4")).toEqual([0, 0, 0, 0, 0, 0xffff, 0x0102, 0x0304]);
    expect(expandV6("1:2:3:4:5:6:7:8:9")).toBeNull();
  });
});

describe("outbound URL validation", () => {
  it("requires https and rejects credentials", async () => {
    await expect(validateOutboundUrl("http://example.com/hook", { lookup: resolveTo("93.184.216.34") })).rejects.toThrow(/https/);
    await expect(validateOutboundUrl("https://user:pw@example.com/hook", { lookup: resolveTo("93.184.216.34") })).rejects.toThrow(/credentials/);
    await expect(validateOutboundUrl("not a url")).rejects.toThrow(SsrfError);
  });

  it("blocks hostnames resolving to private, loopback or metadata addresses (any of them)", async () => {
    await expect(validateOutboundUrl("https://internal.example/hook", { lookup: resolveTo("10.0.0.5") })).rejects.toThrow(/non-public/);
    await expect(validateOutboundUrl("https://mixed.example/hook", { lookup: resolveTo("93.184.216.34", "127.0.0.1") })).rejects.toThrow(/non-public/);
    await expect(validateOutboundUrl("https://[::ffff:169.254.169.254]/x")).rejects.toThrow(/non-public/);
    await expect(validateOutboundUrl("https://169.254.169.254/latest/meta-data")).rejects.toThrow(/non-public/);
  });

  it("pins the resolved public address and honours the admin allowlist", async () => {
    const ok = await validateOutboundUrl("https://hooks.example.com/x", { lookup: resolveTo("93.184.216.34") });
    expect(ok.address).toBe("93.184.216.34");
    const allowed = await validateOutboundUrl("https://ci.internal/x", { lookup: resolveTo("10.0.0.9"), allowlist: ["CI.internal"] });
    expect(allowed.address).toBe("10.0.0.9");
  });

  it("fails closed when DNS fails", async () => {
    await expect(
      validateOutboundUrl("https://nx.example/x", {
        lookup: async () => {
          throw new Error("ENOTFOUND");
        },
      }),
    ).rejects.toThrow(/could not resolve/);
  });
});

describe("safePostJson", () => {
  const lookup = resolveTo("93.184.216.34");

  it("does not follow redirects (a public endpoint cannot bounce us to an internal host)", async () => {
    const calls: string[] = [];
    const transport: RawPost = async (target) => {
      calls.push(target.address);
      return { status: 302, body: "" };
    };
    await expect(safePostJson("https://hooks.example.com/x", { a: 1 }, { lookup, transport })).rejects.toThrow(/redirect/);
    expect(calls).toEqual(["93.184.216.34"]);
  });

  it("connects to the pinned address and reports HTTP failures", async () => {
    let seen: { address: string; host: string; body: string } | null = null;
    const transport: RawPost = async (target, body) => {
      seen = { address: target.address, host: target.url.hostname, body };
      return { status: 500, body: "nope" };
    };
    await expect(safePostJson("https://hooks.example.com/x", { a: 1 }, { lookup, transport })).rejects.toThrow(/HTTP 500/);
    expect(seen).toEqual({ address: "93.184.216.34", host: "hooks.example.com", body: '{"a":1}' });
  });

  it("never reaches the transport for blocked targets", async () => {
    let called = false;
    const transport: RawPost = async () => {
      called = true;
      return { status: 200, body: "" };
    };
    await expect(safePostJson("https://evil.example/x", {}, { lookup: resolveTo("127.0.0.1"), transport })).rejects.toThrow(SsrfError);
    expect(called).toBe(false);
  });
});

describe("Discord adapter", () => {
  it("accepts only Discord webhook URLs", () => {
    expect(() => validateDiscordUrl("https://discord.com/api/webhooks/123456/abc_DEF-1")).not.toThrow();
    expect(() => validateDiscordUrl("https://discordapp.com/api/v10/webhooks/1/x")).not.toThrow();
    expect(() => validateDiscordUrl("http://discord.com/api/webhooks/1/x")).toThrow(/https/);
    expect(() => validateDiscordUrl("https://discord.com.evil.example/api/webhooks/1/x")).toThrow(/discord.com/);
    expect(() => validateDiscordUrl("https://discord.com/api/users/1")).toThrow(/webhook/);
  });

  it("disables mentions so untrusted text cannot ping @everyone", () => {
    const p = discordPayload({ status: "firing", severity: "critical", title: "@everyone hi", text: "x", at: 0 }) as { allowed_mentions: { parse: unknown[] } };
    expect(p.allowed_mentions.parse).toEqual([]);
  });
});
