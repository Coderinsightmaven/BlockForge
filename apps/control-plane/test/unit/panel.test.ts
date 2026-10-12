import { generateKeyPairSync } from "node:crypto";
import { BUILTIN_ROLES, SERVER_OWNER_PERMISSIONS, type Permission, type ScopeType } from "@blockforge/contracts";
import { describe, expect, it } from "vitest";
import { parseAuthorizedKey, sshFingerprint } from "../../src/account/ssh-keys.js";
import { createSafeFetch, SafeFetchError } from "../../src/catalog/safe-fetch.js";
import { BROWSER_TRANSFER_TTL_MS, BrowserTransfers } from "../../src/files/browser-transfers.js";
import { isDenied, isSecretBearing, normalizePath, redactForDisplay } from "../../src/files/policy.js";
import type { Grant, Principal } from "../../src/rbac/authorize.js";
import { effectiveServerPermissions, escalation, mergeSubuserPermissions, permissionList, type ServerResource } from "../../src/servers/permissions.js";
import { transitionalStateFor } from "../../src/servers/state.js";
import { maskSecrets } from "../../src/servers/secret-masks.js";
import type { PinnedGetResult } from "../../src/notifications/http.js";
import { USERNAME_RE, usernameBase, usernameCandidate } from "../../src/users/username.js";
import { buildWorkloadSpec, diagnoseStartupExit, eggEulaFile, minecraftGame, slpExpected, type ServerRuntimeContext } from "../../src/servers/runtime.js";
import { OffsetClock } from "../support/clock.js";
import { authorizedKey, ed25519Key } from "../support/ssh.js";

const NODE = "00000000-0000-4000-8000-0000000000a1";
const SRV = "00000000-0000-4000-8000-00000000a001";
const resource: ServerResource = { type: "server", id: SRV, nodeId: NODE, networkId: null };
const grant = (roleKey: keyof typeof BUILTIN_ROLES, scopeType: ScopeType, scopeId: string | null): Grant => ({
  bindingId: `${roleKey}-${scopeType}`,
  roleKey,
  scopeType,
  scopeId,
  permissions: new Set<Permission>(BUILTIN_ROLES[roleKey].permissions),
});
const user = (id: string, ...grants: Grant[]): Principal => ({ userId: id, email: `${id}@example.com`, username: id, displayName: id, grants });
const facts = (over: Partial<Parameters<typeof effectiveServerPermissions>[1]> = {}) => ({ resource, ownerId: "owner", suspended: false, subuserPermissions: null, ...over });

describe("effective server permissions", () => {
  it("owners get the owner set (no delete, no secrets); strangers nothing", () => {
    const p = effectiveServerPermissions(user("owner"), facts());
    expect([...p].sort()).toEqual([...SERVER_OWNER_PERMISSIONS].sort());
    expect(p.has("servers.delete")).toBe(false);
    expect(p.has("secrets.read")).toBe(false);
    expect(effectiveServerPermissions(user("x"), facts()).size).toBe(0);
  });

  it("unions role bindings and subuser grants, ignoring unknown or unassignable entries", () => {
    const p = effectiveServerPermissions(user("sub"), facts({ subuserPermissions: ["servers.view", "servers.files.read", "secrets.read", "bogus.perm"] }));
    expect(permissionList(p)).toEqual(["servers.files.read", "servers.view"]);
    const mod = effectiveServerPermissions(user("m", grant("moderator", "node", NODE)), facts({ subuserPermissions: ["servers.files.read"] }));
    expect(mod.has("servers.players.manage")).toBe(true);
    expect(mod.has("servers.files.read")).toBe(true);
    // A grant on another node does not apply.
    expect(effectiveServerPermissions(user("m", grant("server_admin", "node", "00000000-0000-4000-8000-0000000000b1")), facts()).size).toBe(0);
  });

  it("suspension leaves only .view permissions unless servers.admin comes from a role", () => {
    const owner = effectiveServerPermissions(user("owner"), facts({ suspended: true }));
    expect([...owner].every((p) => p.endsWith(".view"))).toBe(true);
    expect(owner.has("servers.view")).toBe(true);
    const admin = effectiveServerPermissions(user("a", grant("admin", "global", null)), facts({ suspended: true }));
    expect(admin.has("servers.control")).toBe(true);
    // servers.admin cannot be smuggled in through a subuser grant.
    const sub = effectiveServerPermissions(user("s"), facts({ suspended: true, subuserPermissions: ["servers.admin", "servers.control"] }));
    expect(sub.has("servers.control")).toBe(false);
  });

  it("escalation flags permissions the granter lacks or that are not assignable", () => {
    const held = new Set<Permission>(["servers.view", "servers.console.view"]);
    expect(escalation(["servers.view"], held)).toEqual([]);
    expect(escalation(["servers.view", "servers.control", "secrets.read", "x.y"], held)).toEqual(["servers.control", "secrets.read", "x.y"]);
  });

  it("subuser updates are relative to the granter: (old ∖ held) ∪ (requested ∩ held)", () => {
    const held = new Set<Permission>(["servers.view", "servers.console.view", "servers.files.read"]);
    expect(mergeSubuserPermissions(["servers.view", "servers.files.write"], ["servers.console.view"], held)).toEqual(["servers.console.view", "servers.files.write"]);
    expect(mergeSubuserPermissions(["servers.view", "servers.files.read"], ["servers.view"], held)).toEqual(["servers.view"]);
    // Requested permissions outside the granter's set are ignored here (the service answers 403 first).
    expect(mergeSubuserPermissions([], ["servers.control"], held)).toEqual([]);
  });
});

describe("operation states", () => {
  it("maps operations to transitional states", () => {
    expect(transitionalStateFor("start", "stopped")).toBe("starting");
    expect(transitionalStateFor("restart", "running")).toBe("stopping");
    expect(transitionalStateFor("restart", "crashed")).toBe("starting");
    expect(transitionalStateFor("kill", "running")).toBe("running");
    expect(transitionalStateFor("reinstall", "stopped")).toBe("provisioning");
    expect(transitionalStateFor("delete", "crashed")).toBe("deleting");
  });
});

describe("SSH public keys", () => {
  it("accepts ed25519, ECDSA and RSA ≥ 3072 with OpenSSH SHA256 fingerprints", () => {
    const ed = ed25519Key("me@laptop");
    expect(parseAuthorizedKey(ed.line)).toEqual({ keyType: "ssh-ed25519", publicKey: ed.line.split(" ").slice(0, 2).join(" "), fingerprint: ed.fingerprint, bits: 256 });
    for (const [curve, bits] of [["P-256", 256], ["P-384", 384], ["P-521", 521]] as const) {
      const k = authorizedKey(generateKeyPairSync("ec", { namedCurve: curve }).publicKey);
      expect(parseAuthorizedKey(k.line)).toMatchObject({ fingerprint: k.fingerprint, bits });
    }
    const rsa = authorizedKey(generateKeyPairSync("rsa", { modulusLength: 3072 }).publicKey);
    expect(parseAuthorizedKey(`  ${rsa.line}  `)).toMatchObject({ keyType: "ssh-rsa", bits: 3072, fingerprint: rsa.fingerprint });
    expect(sshFingerprint(ed.blob)).toBe(ed.fingerprint);
    expect(ed.fingerprint).toMatch(/^SHA256:[A-Za-z0-9+/]{43}$/);
  });

  it("refuses short RSA, unknown types, type confusion and malformed blobs", () => {
    const rsa2048 = authorizedKey(generateKeyPairSync("rsa", { modulusLength: 2048 }).publicKey);
    expect(() => parseAuthorizedKey(rsa2048.line)).toThrow(/at least 3072/);
    const ed = ed25519Key();
    const b64 = ed.line.split(" ")[1]!;
    expect(() => parseAuthorizedKey(`ssh-dss ${b64}`)).toThrow(/does not match/);
    expect(() => parseAuthorizedKey(`ssh-ed25519 ${b64.slice(0, 20)}`)).toThrow();
    expect(() => parseAuthorizedKey("ssh-ed25519 not*base64")).toThrow(/base64/);
    expect(() => parseAuthorizedKey(`ssh-ed25519 ${Buffer.concat([ed.blob, Buffer.from([0])]).toString("base64")}`)).toThrow(/trailing/);
    expect(() => parseAuthorizedKey(`sk-ssh-ed25519@openssh.com ${b64}`)).toThrow();
    expect(() => parseAuthorizedKey("ssh-ed25519")).toThrow();
  });
});

describe("file policy", () => {
  it("normalises paths and applies the shared denylist matcher", () => {
    expect(normalizePath("./a//b/")).toBe("a/b");
    const deny = ["secrets/", "*.key", "!public.key", "/root-only.txt"];
    expect(isDenied("secrets", deny)).toBe(true);
    expect(isDenied("secrets/x/y.txt", deny)).toBe(true);
    expect(isDenied("a/b/server.key", deny)).toBe(true);
    expect(isDenied("public.key", deny)).toBe(false);
    expect(isDenied("root-only.txt", deny)).toBe(true);
    expect(isDenied("sub/root-only.txt", deny)).toBe(false);
    expect(isDenied("", deny)).toBe(false);
    expect(isDenied("anything", [])).toBe(false);
  });

  it("identifies and redacts proxy secret files", () => {
    expect(isSecretBearing("forwarding.secret")).toBe(true);
    expect(isSecretBearing("plugins/x/forwarding.secret")).toBe(true);
    expect(isSecretBearing("velocity.toml")).toBe(true);
    expect(isSecretBearing("config/paper-global.yml")).toBe(true);
    expect(isSecretBearing("server.properties")).toBe(false);
    const r = redactForDisplay("velocity.toml", 'bind = "0.0.0.0:25565"\nforwarding-secret-file = "forwarding.secret"\n');
    expect(r.content).toContain("bind");
    const f = redactForDisplay("forwarding.secret", "topsecret");
    expect(f.redacted).toBe(true);
    expect(f.content).not.toContain("topsecret");
  });
});

describe("browser transfer tokens", () => {
  it("are single use, session and direction bound, and expire after five minutes", () => {
    const clock = new OffsetClock();
    const bt = new BrowserTransfers(clock);
    const base = { sessionId: "s1", userId: "u", serverId: SRV, nodeId: NODE, path: "a.txt", maxBytes: 10 };
    const up = bt.issue({ ...base, direction: "upload" });
    expect(up.token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    const ttl = up.expiresAt - clock.now();
    expect(ttl).toBeLessThanOrEqual(BROWSER_TRANSFER_TTL_MS);
    expect(ttl).toBeGreaterThan(BROWSER_TRANSFER_TTL_MS - 1000);
    expect(bt.consume(up.token, "s2", "upload")).toBeNull();
    expect(bt.consume(up.token, "s1", "download")).toBeNull();
    expect(bt.consume(up.token, "s1", "upload")).toMatchObject({ path: "a.txt" });
    expect(bt.consume(up.token, "s1", "upload")).toBeNull();
    const late = bt.issue({ ...base, direction: "download" });
    clock.advance(BROWSER_TRANSFER_TTL_MS + 1);
    expect(bt.consume(late.token, "s1", "download")).toBeNull();
  });
});

describe("catalogue safe fetch", () => {
  const publicDns = async () => [{ address: "151.101.1.1", family: 4 }];
  const ok = (body = "{}", init: ResponseInit = {}) => new Response(body, { status: 200, ...init });

  it("allows HTTPS to allowlisted public hosts only", async () => {
    const calls: string[] = [];
    const f = createSafeFetch({ allowedHosts: ["fill.papermc.io"], lookup: publicDns, fetchImpl: (async (u: string) => (calls.push(u), ok('{"a":1}'))) as typeof fetch });
    expect(await (await f("https://fill.papermc.io/v3/projects")).json()).toEqual({ a: 1 });
    await expect(f("http://fill.papermc.io/v3/projects")).rejects.toThrow(SafeFetchError);
    await expect(f("https://evil.example/")).rejects.toThrow(/allowlist/);
    const priv = createSafeFetch({ allowedHosts: ["fill.papermc.io"], lookup: async () => [{ address: "10.0.0.1", family: 4 }], fetchImpl: (async () => ok()) as unknown as typeof fetch });
    await expect(priv("https://fill.papermc.io/")).rejects.toThrow(SafeFetchError);
    const mapped = createSafeFetch({ allowedHosts: ["fill.papermc.io"], lookup: async () => [{ address: "::ffff:127.0.0.1", family: 6 }], fetchImpl: (async () => ok()) as unknown as typeof fetch });
    await expect(mapped("https://fill.papermc.io/")).rejects.toThrow(SafeFetchError);
    expect(calls).toEqual(["https://fill.papermc.io/v3/projects"]);
  });

  it("re-validates every redirect hop and caps redirects and body size", async () => {
    const hops: Record<string, Response | (() => Response)> = {};
    const impl = (async (u: string) => {
      const r = hops[u];
      return typeof r === "function" ? r() : (r ?? new Response("nf", { status: 404 }));
    }) as typeof fetch;
    const f = createSafeFetch({ allowedHosts: ["a.example", "b.example"], lookup: publicDns, fetchImpl: impl, maxBytes: 16, maxRedirects: 2 });
    hops["https://a.example/x"] = () => new Response(null, { status: 302, headers: { location: "https://b.example/y" } });
    hops["https://b.example/y"] = () => ok("small");
    expect(await (await f("https://a.example/x")).text()).toBe("small");
    hops["https://a.example/out"] = () => new Response(null, { status: 301, headers: { location: "https://169.254.169.254/latest/meta-data" } });
    await expect(f("https://a.example/out")).rejects.toThrow(/allowlist/);
    hops["https://a.example/http"] = () => new Response(null, { status: 302, headers: { location: "http://b.example/y" } });
    await expect(f("https://a.example/http")).rejects.toThrow(/non-HTTPS/);
    hops["https://a.example/loop"] = () => new Response(null, { status: 302, headers: { location: "/loop" } });
    await expect(f("https://a.example/loop")).rejects.toThrow(/too many redirects/);
    hops["https://a.example/big"] = () => ok("x".repeat(17));
    await expect(f("https://a.example/big")).rejects.toThrow(/exceeds 16 bytes/);
    hops["https://a.example/declared"] = () => ok("x", { headers: { "content-length": "1000" } });
    await expect(f("https://a.example/declared")).rejects.toThrow(/too large/);
  });
});

describe("egg runtime (Minecraft-aware)", () => {
  const ctxFor = (game: "minecraft-java" | "minecraft-proxy" | "other", over: Record<string, unknown> = {}) =>
    ({
      server: { id: SRV, nodeId: NODE, dockerImage: "ghcr.io/pterodactyl/yolks:java_21", memoryLimitBytes: 2 * 1024 ** 3, cpuLimitMillicores: null, restartPolicy: { mode: "on-failure", maxRetries: 3, backoffMs: 10_000 }, software: null, location: null, allocationLimit: 0, timezone: "UTC", ...over },
      template: {
        key: "egg",
        kind: "egg",
        game,
        features: game === "minecraft-java" ? ["eula"] : [],
        startup: "java -jar {{SERVER_JARFILE}}",
        variables: [{ envName: "SERVER_JARFILE", name: "Jar", description: "", defaultValue: "server.jar", userViewable: true, userEditable: true, rules: "required|string" }],
        startupDone: [")! For help, type "],
        stop: { type: "command", command: "stop" },
        runtime: { dataMountPath: "/home/container", readOnlyRootfs: false },
        configFiles: [],
      },
      allocations: [{ id: "a", nodeId: NODE, ip: "10.0.0.5", port: 25570, isPrimary: true, serverId: SRV }],
      values: {},
    }) as unknown as ServerRuntimeContext;

  it("sends the game (not the runtime) as the workload kind and enables the JVM probe for Minecraft eggs", () => {
    expect(buildWorkloadSpec(ctxFor("minecraft-java"))).toMatchObject({ kind: "minecraft", jvmProbe: true, entrypoint: "image" });
    expect(buildWorkloadSpec(ctxFor("minecraft-proxy"))).toMatchObject({ kind: "velocity", jvmProbe: true });
    expect(buildWorkloadSpec(ctxFor("other"))).toMatchObject({ kind: "generic", jvmProbe: false });
    expect(minecraftGame(ctxFor("minecraft-proxy"))).toBe("proxy");
    expect(slpExpected(ctxFor("minecraft-java"))).toBe(true);
    expect(slpExpected(ctxFor("minecraft-proxy"))).toBe(false);
    expect(slpExpected(ctxFor("other"))).toBe(false);
  });

  it("diagnoses start-up exits from the console without echoing it", () => {
    const st = { workloadId: SRV, exists: true, state: "exited" as const, exitCode: 1, restartCount: 0 };
    const line = (l: string, ts = 2000) => ({ seq: 1, ts, stream: "stdout" as const, line: l });
    const java = diagnoseStartupExit(
      ctxFor("minecraft-java"),
      st,
      [line("Error: java.lang.UnsupportedClassVersionError: io/papermc/paperclip/Main has been compiled by a more recent version of the Java Runtime (class file version 69.0), this version of the Java Runtime only recognizes class file versions up to 65.0")],
      1000,
    );
    expect(java).toMatchObject({ code: "JAVA_VERSION_MISMATCH", message: "the server needs Java 25 or newer but the image provides Java 21; choose a newer Java image (exit code 1)", exit: { exitCode: 1, oomKilled: false } });
    expect(diagnoseStartupExit(ctxFor("minecraft-java"), st, [line("[12:00:00] [Server thread/WARN]: **** FAILED TO BIND TO PORT!")], 1000).code).toBe("PORT_BIND_FAILED");
    // Output of an earlier run, system lines and non-Minecraft eggs are not classified.
    expect(diagnoseStartupExit(ctxFor("minecraft-java"), st, [line("[12:00:00] [Server thread/WARN]: **** FAILED TO BIND TO PORT!", 500)], 1000).code).toBe("CRASHED");
    expect(diagnoseStartupExit(ctxFor("other"), st, [line("[12:00:00] [Server thread/WARN]: **** FAILED TO BIND TO PORT!")], 1000).code).toBe("CRASHED");
    expect(diagnoseStartupExit(ctxFor("other"), { ...st, exitCode: 137, oomKilled: true }, [], 0)).toMatchObject({ code: "OOM_KILLED", exit: { exitCode: 137, oomKilled: true } });
    expect(diagnoseStartupExit(ctxFor("other"), { ...st, exitCode: undefined }, [], 0).message).toBe("the server exited during start-up");
  });

  it("formats eula.txt for eggs", () => {
    expect(eggEulaFile(new Date("2026-10-12T10:00:00.000Z"), "alice")).toBe("#accepted via BlockForge 2026-10-12T10:00:00.000Z by alice\neula=true\n");
    expect(eggEulaFile(new Date(0), "a\nb")).toBe("#accepted via BlockForge 1970-01-01T00:00:00.000Z by a b\neula=true\n");
  });
});

describe("catalogue fetch pins connections to validated addresses", () => {
  it("passes the validated address of every hop to the transport (no second resolution)", async () => {
    const seen: { host: string; address: string }[] = [];
    let lookups = 0;
    const answers: Record<string, string> = { "a.example": "151.101.1.1", "b.example": "151.101.2.2" };
    const f = createSafeFetch({
      allowedHosts: ["a.example", "b.example"],
      // A rebinding resolver: public on the first query per host, private afterwards.
      lookup: async (host) => {
        lookups++;
        return [{ address: lookups <= 2 ? answers[host]! : "127.0.0.1", family: 4 }];
      },
      pinnedGet: async (target): Promise<PinnedGetResult> => {
        seen.push({ host: target.url.hostname, address: target.address });
        if (target.url.hostname === "a.example") return { status: 302, headers: { location: "https://b.example/next" }, body: Buffer.alloc(0) };
        return { status: 200, headers: { "content-type": "application/json" }, body: Buffer.from('{"ok":true}') };
      },
    });
    expect(await (await f("https://a.example/start")).json()).toEqual({ ok: true });
    expect(seen).toEqual([
      { host: "a.example", address: "151.101.1.1" },
      { host: "b.example", address: "151.101.2.2" },
    ]);
    expect(lookups).toBe(2);
    // A hop whose DNS now answers privately is refused before any connection.
    seen.length = 0;
    await expect(f("https://a.example/start")).rejects.toThrow(SafeFetchError);
    expect(seen).toEqual([]);
  });
});

describe("usernames", () => {
  it("keep suffixed candidates within 32 characters", () => {
    const base = usernameBase(`${"x".repeat(60)}@example.com`);
    expect(base).toHaveLength(28);
    for (const n of [1, 2, 999, 1000, 123_456, 10 ** 9]) {
      const c = usernameCandidate(base, n);
      expect(c.length).toBeLessThanOrEqual(32);
      expect(c).toMatch(USERNAME_RE);
    }
    expect(usernameCandidate(base, 1000)).toBe(`${"x".repeat(27)}-1000`);
    expect(usernameCandidate("alice", 2)).toBe("alice-2");
  });
});

describe("console secret masking", () => {
  it("masks every occurrence, longest values first", () => {
    expect(maskSecrets("pw=hunter22 again hunter22", ["hunter22"])).toBe("pw=•••••• again ••••••");
    expect(maskSecrets("token abcdef123456", ["abcdef123456", "abcdef"])).toBe("token ••••••");
    expect(maskSecrets("nothing here", [])).toBe("nothing here");
  });
});
