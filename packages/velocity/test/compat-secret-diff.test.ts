import { describe, expect, it } from "vitest";
import { assessSecret, base64UrlEncode, diffLines, forwardingCompatibility, forwardingSecretFileContent, generateForwardingSecret, supportsForwarding, unifiedDiff } from "../src/index.js";

describe("forwarding compatibility matrix", () => {
  it("Paper ≥ 1.19 uses config/paper-global.yml for modern forwarding", () => {
    const r = forwardingCompatibility("paper", "1.21.11");
    expect(r.recommended).toBe("modern");
    expect(r.modes.modern).toMatchObject({ level: "native", configFiles: ["config/paper-global.yml", "spigot.yml", "server.properties"] });
    expect(r.modes.modern.steps).toContain("config/paper-global.yml: proxies.velocity.secret = <forwarding secret>");
    expect(r.modes.legacy.level).toBe("native");
    expect(r.modes.bungeeguard).toMatchObject({ level: "plugin", requires: ["BungeeGuard plugin"] });
    expect(r.requiresOfflineMode).toBe(true);
    expect(r.notes.join(" ")).toMatch(/enforce-secure-profile/);
  });

  it("Paper ≤ 1.18.2 uses paper.yml; 1.13 needs build 377; < 1.13 has no modern forwarding", () => {
    expect(forwardingCompatibility("paper", "1.18.2").modes.modern.configFiles[0]).toBe("paper.yml");
    expect(forwardingCompatibility("paper", "1.13.2").modes.modern.notes.join(" ")).toMatch(/377/);
    const old = forwardingCompatibility("paper", "1.12.2");
    expect(old.modes.modern.level).toBe("unsupported");
    expect(old.recommended).toBe("bungeeguard");
  });

  it("Purpur and Folia follow Paper", () => {
    expect(supportsForwarding("purpur", "26.3", "modern")).toBe("native");
    expect(forwardingCompatibility("folia", "26.2").modes.modern.configFiles[0]).toBe("config/paper-global.yml");
  });

  it("Spigot only supports legacy/BungeeGuard; vanilla only none", () => {
    expect(supportsForwarding("spigot", "1.21.11", "modern")).toBe("unsupported");
    expect(supportsForwarding("spigot", "1.21.11", "legacy")).toBe("native");
    const v = forwardingCompatibility("vanilla", "26.3");
    expect([v.modes.modern.level, v.modes.legacy.level, v.modes.bungeeguard.level, v.modes.none.level]).toEqual(["unsupported", "unsupported", "unsupported", "native"]);
    expect(v.recommended).toBeNull();
  });

  it("Fabric needs FabricProxy-Lite (1.16.5+), no legacy", () => {
    const f = forwardingCompatibility("fabric", "1.21.11");
    expect(f.modes.modern).toMatchObject({ level: "mod", requires: ["FabricProxy-Lite", "Fabric API"], configFiles: ["config/FabricProxy-Lite.toml", "server.properties"] });
    expect(f.modes.legacy.level).toBe("unsupported");
    expect(supportsForwarding("fabric", "1.14.4", "modern")).toBe("unsupported");
  });

  it("Forge/NeoForge need Proxy Compatible Forge within its published range", () => {
    expect(forwardingCompatibility("forge", "1.20.1").modes.modern).toMatchObject({ level: "mod", requires: ["Proxy Compatible Forge (PCF)"] });
    expect(forwardingCompatibility("forge", "1.20.1").notes.join(" ")).toMatch(/Ambassador/);
    expect(forwardingCompatibility("forge", "1.14.4").modes.modern.requires).toContain("MixinBootstrap");
    expect(forwardingCompatibility("forge", "1.13.2").modes.modern.requires).toContain("ModernMixins");
    expect(supportsForwarding("forge", "26.3", "modern")).toBe("unknown");
    expect(supportsForwarding("forge", "26.2", "modern")).toBe("mod");
    expect(forwardingCompatibility("forge", "1.12.2").modes.legacy).toMatchObject({ level: "mod", requires: ["BungeeForge"] });
    expect(supportsForwarding("forge", "1.12.2", "modern")).toBe("unsupported");
    expect(forwardingCompatibility("neoforge", "1.21.1").modes.modern.notes.join(" ")).toMatch(/NeoVelocity/);
    expect(supportsForwarding("neoforge", "1.20.1", "modern")).toBe("mod");
    expect(supportsForwarding("neoforge", "26.3", "modern")).toBe("unknown");
  });
});

describe("forwarding secrets", () => {
  it("generates 32 random bytes as 43-char base64url", () => {
    const a = generateForwardingSecret();
    const b = generateForwardingSecret();
    expect(a).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(a).not.toBe(b);
    expect(assessSecret(a)).toMatchObject({ present: true, strong: true, byteLength: 43 });
    expect(assessSecret(a).estimatedEntropyBits).toBeGreaterThanOrEqual(256);
    expect(() => generateForwardingSecret(16)).toThrow();
  });

  it("encodes base64url per RFC 4648 test vectors", () => {
    const enc = (s: string) => base64UrlEncode(new TextEncoder().encode(s));
    expect(["", "f", "fo", "foo", "foob", "fooba", "foobar"].map(enc)).toEqual(["", "Zg", "Zm8", "Zm9v", "Zm9vYg", "Zm9vYmE", "Zm9vYmFy"]);
    expect(base64UrlEncode(new Uint8Array([0xfb, 0xff, 0xbf]))).toBe("-_-_");
  });

  it("flags missing, short, repetitive and multi-line secrets without echoing them", () => {
    expect(assessSecret(null)).toMatchObject({ present: false, strong: false });
    const velocityDefault = assessSecret("Q8hd73KsLw0p"); // Velocity writes 12 random chars by default
    expect(velocityDefault.strong).toBe(false);
    expect(velocityDefault.problems.join(" ")).toMatch(/bits of entropy/);
    expect(assessSecret("a".repeat(64)).problems.join(" ")).toMatch(/repetitive/);
    expect(assessSecret(`${generateForwardingSecret()}\n`).problems.join(" ")).toMatch(/line breaks/);
    expect(JSON.stringify(assessSecret("Q8hd73KsLw0p"))).not.toContain("Q8hd73KsLw0p");
    expect(() => forwardingSecretFileContent("a\nb")).toThrow();
    expect(forwardingSecretFileContent("abc")).toBe("abc");
  });
});

describe("line diff", () => {
  it("computes minimal edit scripts (Myers)", () => {
    const ops = diffLines("a b c a b b a".split(" "), "c b a b a c".split(" "));
    expect(ops.filter((o) => o.op !== "equal")).toHaveLength(5); // D = 5 for the paper's example
    expect(ops.filter((o) => o.op !== "insert").map((o) => o.text)).toEqual("a b c a b b a".split(" "));
    expect(ops.filter((o) => o.op !== "delete").map((o) => o.text)).toEqual("c b a b a c".split(" "));
    expect(diffLines([], [])).toEqual([]);
    expect(diffLines(["x"], [])).toEqual([{ op: "delete", text: "x" }]);
  });

  it("formats unified diffs like diff -u", () => {
    const before = ["1", "2", "3", "4", "5", "6", "7", "8", "9", "10"].join("\n") + "\n";
    const after = before.replace("2\n", "two\n").replace("9\n", "9\nnine-and-a-half\n");
    expect(unifiedDiff(before, after, { oldPath: "f.txt" })).toBe(
      ["--- a/f.txt", "+++ b/f.txt", "@@ -1,5 +1,5 @@", " 1", "-2", "+two", " 3", " 4", " 5", "@@ -7,4 +7,5 @@", " 7", " 8", " 9", "+nine-and-a-half", " 10", ""].join("\n"),
    );
    expect(unifiedDiff(before, before)).toBe("");
  });

  it("handles created files and missing final newlines", () => {
    expect(unifiedDiff("", "secret-free\n", { oldPath: "x", oldMissing: true })).toBe("--- /dev/null\n+++ b/x\n@@ -0,0 +1 @@\n+secret-free\n");
    expect(unifiedDiff("a\nb", "a\nb\n", { oldPath: "x" })).toBe("--- a/x\n+++ b/x\n@@ -1,2 +1,2 @@\n a\n-b\n\\ No newline at end of file\n+b\n");
  });
});
