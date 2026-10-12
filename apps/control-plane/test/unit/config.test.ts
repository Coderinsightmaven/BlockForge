import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pino } from "pino";
import { afterEach, describe, expect, it } from "vitest";
import { ConfigError, loadConfig } from "../../src/config/env.js";
import { loadMasterKey, MasterKeyError, parseMasterKey } from "../../src/config/master-key.js";

const silent = pino({ level: "silent" });

describe("config", () => {
  it("applies documented defaults in development", () => {
    const c = loadConfig({}, "/srv/bf");
    expect(c.env).toBe("development");
    expect(c.publicUrl).toBe("http://127.0.0.1:5173");
    expect(c.publicOrigin).toBe("http://127.0.0.1:5173");
    expect(c.listenHost).toBe("127.0.0.1");
    expect(c.listenPort).toBe(8080);
    expect(c.dataDir.replace(/\\/g, "/")).toMatch(/\/srv\/bf\/\.data$/);
    expect(c.cookieSecure).toBe(false);
    expect(c.trustProxy).toBe(false);
    expect(c.smtp).toBeNull();
    expect(c.agentUrl).toBe(c.publicUrl);
    expect(c.databaseUrl).toContain("55432");
  });

  it("derives secure cookies from an https PUBLIC_URL and parses TRUST_PROXY", () => {
    const c = loadConfig({ PUBLIC_URL: "https://cp.example.com/", TRUST_PROXY: "10.0.0.1, 10.0.0.2" });
    expect(c.cookieSecure).toBe(true);
    expect(c.publicUrl).toBe("https://cp.example.com");
    expect(c.trustProxy).toEqual(["10.0.0.1", "10.0.0.2"]);
    expect(loadConfig({ TRUST_PROXY: "2" }).trustProxy).toBe(2);
    expect(loadConfig({ TRUST_PROXY: "true" }).trustProxy).toBe(true);
    expect(loadConfig({ COOKIE_SECURE: "false", PUBLIC_URL: "https://x.example" }).cookieSecure).toBe(false);
  });

  it("requires DATABASE_URL, VICTORIA_METRICS_URL and the master key in production", () => {
    expect(() => loadConfig({ NODE_ENV: "production" })).toThrow(ConfigError);
    try {
      loadConfig({ NODE_ENV: "production" });
    } catch (err) {
      const msg = (err as ConfigError).issues.join("\n");
      expect(msg).toContain("DATABASE_URL");
      expect(msg).toContain("VICTORIA_METRICS_URL");
      expect(msg).toContain("BLOCKFORGE_MASTER_KEY");
    }
  });

  it("rejects malformed values", () => {
    expect(() => loadConfig({ LISTEN_PORT: "99999" })).toThrow(ConfigError);
    expect(() => loadConfig({ PUBLIC_URL: "not a url" })).toThrow(ConfigError);
    expect(() => loadConfig({ SMTP_HOST: "smtp.example.com" })).toThrow(/SMTP_FROM/);
    expect(loadConfig({ SMTP_HOST: "smtp.example.com", SMTP_FROM: "bf@example.com" }).smtp?.port).toBe(587);
  });

  it("treats empty variables as unset", () => {
    expect(loadConfig({ LISTEN_PORT: "", PUBLIC_URL: "" }).listenPort).toBe(8080);
  });
});

describe("master key", () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });

  it("parses base64 (standard or url-safe) 32-byte keys only", () => {
    const k = Buffer.alloc(32, 7);
    expect(parseMasterKey(k.toString("base64")).equals(k)).toBe(true);
    expect(parseMasterKey(k.toString("base64url")).equals(k)).toBe(true);
    expect(() => parseMasterKey(Buffer.alloc(16).toString("base64"))).toThrow(MasterKeyError);
    expect(() => parseMasterKey("!!!")).toThrow(MasterKeyError);
  });

  it("auto-generates a 0600 key file in development and reuses it", async () => {
    const dir = mkdtempSync(join(tmpdir(), "bf-key-"));
    dirs.push(dir);
    const config = loadConfig({ DATA_DIR: dir });
    const a = await loadMasterKey(config, silent);
    const b = await loadMasterKey(config, silent);
    expect(a.length).toBe(32);
    expect(a.equals(b)).toBe(true);
    expect(readFileSync(join(dir, "master.key"), "utf8").trim()).toBe(a.toString("base64"));
    if (process.platform !== "win32") expect(statSync(join(dir, "master.key")).mode & 0o777).toBe(0o600);
  });

  it("refuses to auto-generate in production", async () => {
    const config = { ...loadConfig({}), env: "production" as const, masterKeyBase64: null };
    await expect(loadMasterKey(config, silent)).rejects.toThrow(/required in production/);
  });
});
