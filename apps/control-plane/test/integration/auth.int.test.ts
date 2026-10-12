import { CSRF_HEADER, Me } from "@blockforge/contracts";
import { generate } from "otplib";
import { afterEach, describe, expect, it } from "vitest";
import { ApiClient, OWNER_PASSWORD, startTestApp, startWithOwner, type TestApp } from "../support/app.js";
import { testPool } from "../support/db.js";

let t: TestApp | null = null;
afterEach(async () => {
  await t?.close();
  t = null;
});

async function totp(secret: string, offsetSteps = 0): Promise<string> {
  return generate({ secret, epoch: Math.floor(Date.now() / 1000) + offsetSteps * 30 });
}

describe("first-run setup", () => {
  it("requires the one-time token, creates the owner, logs in and cannot run twice", async () => {
    t = await startTestApp();
    const c = new ApiClient(t);
    expect((await c.get("/auth/setup")).json()).toEqual({ setupRequired: true });
    expect(t.setupToken).toMatch(/^[A-Za-z0-9_-]{32}$/);

    const bad = await c.post("/auth/setup", { setupToken: "x".repeat(32), email: "o@example.com", displayName: "O", password: OWNER_PASSWORD });
    expect(bad.statusCode).toBe(401);
    expect(bad.json().error.code).toBe("UNAUTHENTICATED");
    expect(bad.headers["x-request-id"]).toBeTruthy();
    expect(bad.json().error.requestId).toBe(bad.headers["x-request-id"]);

    const weak = await c.post("/auth/setup", { setupToken: t.setupToken, email: "o@example.com", displayName: "O", password: "short" });
    expect(weak.statusCode).toBe(400);
    expect(weak.json().error.code).toBe("VALIDATION_FAILED");

    const ok = await c.setup("Owner@Example.com");
    expect(ok.statusCode).toBe(201);
    const me = Me.parse(ok.json());
    expect(me.user.email).toBe("owner@example.com");
    expect(me.user.roles.map((r) => r.roleKey)).toEqual(["owner"]);
    expect(me.globalPermissions).toContain("users.manage");
    const cookie = ok.cookies.find((x) => x.name === "bf_session");
    expect(cookie?.httpOnly).toBe(true);
    expect(cookie?.sameSite).toBe("Lax");

    expect((await c.get("/auth/setup")).json()).toEqual({ setupRequired: false });
    const again = await c.post("/auth/setup", { setupToken: t.setupToken, email: "x@example.com", displayName: "X", password: OWNER_PASSWORD });
    expect(again.statusCode).toBe(409);
    expect(again.json().error.code).toBe("SETUP_ALREADY_COMPLETED");

    // The stored token is a hash, cleared after use.
    const { rows } = await testPool().query("SELECT setup_token_hash FROM setup_state");
    expect(rows[0].setup_token_hash).toBeNull();
    const { rows: users } = await testPool().query("SELECT password_hash FROM users");
    expect(users[0].password_hash).toMatch(/^\$argon2id\$/);
  });
});

describe("sessions, CSRF and login", () => {
  it("logs in, enforces CSRF on state-changing requests and logs out", async () => {
    ({ t } = await startWithOwner());
    const c = new ApiClient(t);
    expect((await c.get("/auth/me")).statusCode).toBe(401);
    expect((await c.get("/users")).json().error.code).toBe("UNAUTHENTICATED");

    const wrong = await c.login("owner@example.com", "wrong password!!");
    expect(wrong.statusCode).toBe(401);
    expect(wrong.json().error.message).toBe("Invalid email or password");
    const unknown = await c.login("nobody@example.com", "wrong password!!");
    expect(unknown.json().error.message).toBe("Invalid email or password");

    const ok = await c.login("OWNER@example.com", OWNER_PASSWORD);
    expect(ok.statusCode).toBe(200);
    expect(ok.json().status).toBe("ok");
    const me = (await c.get("/auth/me")).json();
    expect(me.csrfToken).toBe(c.csrf);

    // Missing / wrong CSRF header → 403 CSRF_INVALID; correct header → allowed.
    const noCsrf = await c.request("POST", "/auth/mfa/enroll", {}, { [CSRF_HEADER]: "" });
    expect(noCsrf.statusCode).toBe(403);
    expect(noCsrf.json().error.code).toBe("CSRF_INVALID");
    const wrongCsrf = await c.request("POST", "/auth/mfa/enroll", {}, { [CSRF_HEADER]: "forged-token" });
    expect(wrongCsrf.json().error.code).toBe("CSRF_INVALID");
    const otherSession = new ApiClient(t);
    await otherSession.login("owner@example.com", OWNER_PASSWORD);
    const crossSession = await c.request("POST", "/auth/mfa/enroll", {}, { [CSRF_HEADER]: otherSession.csrf ?? "" });
    expect(crossSession.json().error.code).toBe("CSRF_INVALID");
    expect((await c.post("/auth/mfa/enroll")).statusCode).toBe(200);

    expect((await c.request("POST", "/auth/logout", {}, { [CSRF_HEADER]: "" })).statusCode).toBe(403);
    expect((await c.post("/auth/logout")).statusCode).toBe(204);
    expect((await c.get("/auth/me")).statusCode).toBe(401);
  });

  it("locks the account progressively after repeated failures", async () => {
    ({ t } = await startWithOwner());
    const c = new ApiClient(t);
    for (let i = 0; i < 5; i++) expect((await c.login("owner@example.com", `wrong-password-${i}`)).statusCode).toBe(401);
    const locked = await c.login("owner@example.com", OWNER_PASSWORD);
    expect(locked.statusCode).toBe(429);
    expect(locked.json().error.code).toBe("RATE_LIMITED");
    expect(Number(locked.headers["retry-after"])).toBeGreaterThan(0);
    const { rows } = await testPool().query("SELECT failed_login_count, locked_until FROM users");
    expect(rows[0].failed_login_count).toBe(5);
    expect(new Date(rows[0].locked_until).getTime()).toBeGreaterThan(Date.now());
    // Audit records the failures and the denial.
    const { rows: audit } = await testPool().query("SELECT outcome, count(*)::int AS n FROM audit_events WHERE action = 'auth.login' GROUP BY outcome");
    expect(Object.fromEntries(audit.map((r) => [r.outcome, r.n]))).toMatchObject({ failed: 5, denied: 1 });
  });

  it("rate-limits login per IP", async () => {
    ({ t } = await startWithOwner());
    const c = new ApiClient(t);
    let limited = 0;
    for (let i = 0; i < 25; i++) {
      const r = await c.post("/auth/login", { email: `user${i}@example.com`, password: "x" });
      if (r.statusCode === 429) {
        limited++;
        expect(r.json().error.code).toBe("RATE_LIMITED");
      }
    }
    expect(limited).toBeGreaterThan(0);
  });

  it("password change revokes the other sessions", async () => {
    ({ t } = await startWithOwner());
    const a = new ApiClient(t);
    const b = new ApiClient(t);
    await a.login("owner@example.com", OWNER_PASSWORD);
    await b.login("owner@example.com", OWNER_PASSWORD);
    const bad = await a.post("/auth/password", { currentPassword: "nope", newPassword: "a brand new password" });
    expect(bad.statusCode).toBe(400);
    expect((await a.post("/auth/password", { currentPassword: OWNER_PASSWORD, newPassword: "a brand new password" })).statusCode).toBe(204);
    expect((await a.get("/auth/me")).statusCode).toBe(200);
    expect((await b.get("/auth/me")).statusCode).toBe(401);
    expect((await new ApiClient(t).login("owner@example.com", "a brand new password")).statusCode).toBe(200);
  });

  it("expires idle sessions", async () => {
    ({ t } = await startWithOwner());
    const c = new ApiClient(t);
    await c.login("owner@example.com", OWNER_PASSWORD);
    await testPool().query("UPDATE sessions SET last_seen_at = now() - interval '13 hours'");
    expect((await c.get("/auth/me")).statusCode).toBe(401);
  });
});

describe("TOTP MFA", () => {
  it("enrolls, gates sessions until verified, rejects replays and disables", async () => {
    let owner: ApiClient;
    ({ t, owner } = await startWithOwner());
    const start = await owner.post("/auth/mfa/enroll");
    expect(start.statusCode).toBe(200);
    const { secret, otpauthUrl } = start.json();
    expect(otpauthUrl).toMatch(/^otpauth:\/\/totp\/BlockForge:owner%40example\.com\?/);
    const { rows: pending } = await testPool().query("SELECT mfa_pending_secret_enc FROM users");
    expect(pending[0].mfa_pending_secret_enc).not.toContain(secret);

    expect((await owner.post("/auth/mfa/enroll/confirm", { code: "000000" })).statusCode).toBe(400);
    expect((await owner.post("/auth/mfa/enroll/confirm", { code: await totp(secret, -1) })).statusCode).toBe(204);
    expect((await owner.get("/auth/me")).json().user.mfaEnabled).toBe(true);
    expect((await owner.post("/auth/mfa/enroll")).statusCode).toBe(409);

    const c = new ApiClient(t);
    const login = await c.login("owner@example.com", OWNER_PASSWORD);
    expect(login.json()).toEqual({ status: "mfa_required" });
    const me = (await c.get("/auth/me")).json();
    expect(me.session.mfaVerified).toBe(false);
    const gated = await c.get("/users");
    expect(gated.statusCode).toBe(401);
    expect(gated.json().error.code).toBe("MFA_REQUIRED");
    expect((await c.post("/auth/mfa/verify", { code: "123456" })).statusCode).toBe(400);

    // The code used for confirmation (same time step) is rejected as a replay.
    const replay = await c.post("/auth/mfa/verify", { code: await totp(secret, -1) });
    expect(replay.statusCode).toBe(400);
    const pre = c.cookies.get("bf_session");
    const verified = await c.post("/auth/mfa/verify", { code: await totp(secret) });
    expect(verified.statusCode).toBe(200);
    expect(verified.json().session.mfaVerified).toBe(true);
    expect(c.cookies.get("bf_session")).not.toBe(pre); // session rotated on verification
    c.csrf = verified.json().csrfToken;
    expect((await c.get("/users")).statusCode).toBe(200);

    expect((await c.post("/auth/mfa/disable", { code: "111111" })).statusCode).toBe(400);
    expect((await c.post("/auth/mfa/disable", { code: await totp(secret, 1) })).statusCode).toBe(204);
    expect((await c.get("/auth/me")).json().user.mfaEnabled).toBe(false);
  });

  it("revokes a pending-MFA session after too many wrong codes", async () => {
    let owner: ApiClient;
    ({ t, owner } = await startWithOwner());
    const { secret } = (await owner.post("/auth/mfa/enroll")).json();
    await owner.post("/auth/mfa/enroll/confirm", { code: await totp(secret) });
    const c = new ApiClient(t);
    await c.login("owner@example.com", OWNER_PASSWORD);
    for (let i = 0; i < 4; i++) expect((await c.post("/auth/mfa/verify", { code: "000001" })).statusCode).toBe(400);
    expect((await c.post("/auth/mfa/verify", { code: "000001" })).statusCode).toBe(401);
    expect((await c.get("/auth/me")).statusCode).toBe(401);
  });
});

describe("HTTP basics", () => {
  it("serves health, readiness, 404s in ApiError format and security headers", async () => {
    ({ t } = await startWithOwner());
    expect((await t.app.inject({ url: "/healthz" })).json()).toEqual({ status: "ok" });
    const ready = await t.app.inject({ url: "/readyz" });
    expect(ready.statusCode).toBe(200);
    expect(ready.json().components).toMatchObject({ database: { ok: true }, migrations: { ok: true }, victoriaMetrics: { ok: true } });
    const nf = await t.app.inject({ url: "/api/v1/nope", headers: { "x-request-id": "req-123" } });
    expect(nf.statusCode).toBe(404);
    expect(nf.json()).toEqual({ error: { code: "NOT_FOUND", message: "Route GET /api/v1/nope not found", requestId: "req-123" } });
    expect(nf.headers["x-request-id"]).toBe("req-123");
    const csp = String(nf.headers["content-security-policy"]);
    expect(csp).toContain("default-src 'self'");
    expect(csp).toContain("script-src 'self'");
    expect(csp).toContain("frame-ancestors 'none'");
    expect(nf.headers["x-content-type-options"]).toBe("nosniff");
    const badJson = await t.app.inject({ method: "POST", url: "/api/v1/auth/login", headers: { "content-type": "application/json" }, payload: "{" });
    expect(badJson.statusCode).toBe(400);
    expect(badJson.json().error.code).toBe("VALIDATION_FAILED");
  });
});
