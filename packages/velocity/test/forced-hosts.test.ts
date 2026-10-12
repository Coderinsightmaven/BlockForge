import { describe, expect, it } from "vitest";
import { dnsGuidance, normalizeHostname, validateForcedHosts } from "../src/index.js";

describe("normalizeHostname", () => {
  it.each([
    [" Play.Example.COM. ", "play.example.com"],
    ["survival.example.com", "survival.example.com"],
    ["bücher.example", "xn--bcher-kva.example"],
    ["ＥＸＡＭＰＬＥ.com", "example.com"],
    ["例え.テスト", "xn--r8jz45g.xn--zckzah"],
    ["localhost", "localhost"],
  ])("%j → %s", (input, expected) => {
    const r = normalizeHostname(input);
    expect(r.ok).toBe(true);
    expect(r.hostname).toBe(expected);
  });

  it.each([
    ["*.example.com", /Wildcards/],
    ["play.example.com:25566", /not allowed/],
    ["http://play.example.com", /not allowed/],
    ["play..example.com", /empty label/],
    [".example.com", /empty label/],
    ["under_score.example.com", /not valid/],
    ["-bad.example.com", /not valid/],
    [`${"a".repeat(64)}.com`, /1–63/],
    ["example.123", /all-numeric|not a valid hostname/i],
    ["0x7f.0.0.1", /canonical/],
    ["[::1]", /not allowed/],
    ["", /empty/],
  ])("rejects %j", (input, msg) => {
    const r = normalizeHostname(input);
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(msg);
  });

  it("warns about IP literals, single labels and IDNA deviations", () => {
    expect(normalizeHostname("203.0.113.7").warnings.join(" ")).toMatch(/IP address/);
    expect(normalizeHostname("localhost").warnings.join(" ")).toMatch(/Single-label/);
    const ss = normalizeHostname("faß.example");
    expect(ss.ok).toBe(true);
    expect(ss.warnings.join(" ")).toMatch(/IDNA 2003/);
    expect(normalizeHostname("bücher.example").warnings.join(" ")).toMatch(/ASCII form/);
  });
});

describe("validateForcedHosts", () => {
  const backends = [
    { name: "lobby", state: "running" as const, inNetwork: true },
    { name: "survival", state: "stopped" as const, inNetwork: true },
    { name: "old", state: "running" as const, inNetwork: false },
  ];
  const codes = (r: { issues: Array<{ code: string }> }) => r.issues.map((i) => i.code);

  it("normalises and keeps valid mappings", () => {
    const r = validateForcedHosts([{ hostname: "Play.Example.com.", targets: ["lobby"] }], backends);
    expect(r.mappings).toEqual([{ hostname: "play.example.com", targets: ["lobby"] }]);
    expect(r.issues).toEqual([]); // case and trailing-dot normalisation is silent
  });

  it("detects duplicates and conflicts after normalisation", () => {
    const dup = validateForcedHosts(
      [
        { hostname: "play.example.com", targets: ["lobby"] },
        { hostname: "PLAY.example.com.", targets: ["lobby"] },
        { hostname: "play.EXAMPLE.com", targets: ["survival"] },
      ],
      backends,
    );
    expect(codes(dup)).toEqual(expect.arrayContaining(["FORCED_HOST_DUPLICATE", "FORCED_HOST_CONFLICT"]));
    expect(dup.mappings).toHaveLength(1);
  });

  it("validates targets", () => {
    const r = validateForcedHosts(
      [
        { hostname: "a.example.com", targets: [] },
        { hostname: "b.example.com", targets: ["nope"] },
        { hostname: "c.example.com", targets: ["survival", "survival"] },
        { hostname: "d.example.com", targets: ["old"] },
        { hostname: "*.example.com", targets: ["lobby"] },
      ],
      backends,
    );
    expect(codes(r)).toEqual(
      expect.arrayContaining([
        "FORCED_HOST_NO_TARGETS",
        "FORCED_HOST_UNKNOWN_TARGET",
        "FORCED_HOST_TARGET_DOWN",
        "FORCED_HOST_DUPLICATE_TARGET",
        "FORCED_HOST_TARGET_NOT_IN_NETWORK",
        "FORCED_HOST_WILDCARD",
      ]),
    );
    expect(r.mappings.map((m) => m.hostname)).toEqual(["c.example.com", "d.example.com"]);
    expect(r.issues.find((i) => i.code === "FORCED_HOST_TARGET_DOWN")?.severity).toBe("warning");
    expect(r.issues.find((i) => i.code === "FORCED_HOST_UNKNOWN_TARGET")?.severity).toBe("error");
  });
});

describe("dnsGuidance", () => {
  it("suggests A/AAAA/CNAME records and never claims to create them", () => {
    expect(dnsGuidance("play.example.com", "203.0.113.10", 25565).records).toEqual(["play.example.com. A 203.0.113.10"]);
    expect(dnsGuidance("play.example.com", "2001:db8::10", 25565).records).toEqual(["play.example.com. AAAA 2001:db8::10"]);
    const cname = dnsGuidance("play.example.com", "proxy.example.net", null);
    expect(cname.records).toEqual(["play.example.com. CNAME proxy.example.net."]);
    expect(cname.notes.join(" ")).toMatch(/does not create or change DNS records/);
    expect(cname.notes.join(" ")).toMatch(/host name the player's client actually connects with/);
  });

  it("explains SRV records for non-default ports", () => {
    const g = dnsGuidance("survival.example.com", "203.0.113.10", 25577);
    expect(g.records).toContain("_minecraft._tcp.survival.example.com. SRV 0 5 25577 survival.example.com.");
    expect(g.notes.join(" ")).toMatch(/SRV \*target\* name/);
    expect(g.notes.join(" ")).toMatch(/TCP port 25577/);
  });
});
