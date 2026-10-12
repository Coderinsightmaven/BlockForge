import { randomUUID } from "node:crypto";
import { SftpAuthResponse, SshKey } from "@blockforge/contracts";
import { afterEach, describe, expect, it } from "vitest";
import { createUserClient, responseLog, startWithOwner, type ApiClient, type TestApp } from "../support/app.js";
import { testPool } from "../support/db.js";
import type { FakeAgent } from "../support/fake-agent.js";
import { connectSimNode, eggFixture, poll, waitJob, type SimNodeHandle } from "../support/panel.js";
import { authorizedKey, ed25519Key } from "../support/ssh.js";
import { generateKeyPairSync } from "node:crypto";

let t: TestApp | null = null;
const agents: FakeAgent[] = [];
afterEach(async () => {
  for (const a of agents.splice(0)) await a.close().catch(() => undefined);
  await t?.close();
  t = null;
});

const PASSWORD = "user password is long enough";

async function setup(): Promise<{ t: TestApp; owner: ApiClient; alice: ApiClient; aliceId: string; node: SimNodeHandle; id: string; short: string }> {
  const r = await startWithOwner({ background: true });
  t = r.t;
  const owner = r.owner;
  const node = await connectSimNode(r.t, owner, { agents, sim: { installCreates: { "server.jar": "jar" } } });
  const imported = await owner.post("/templates/import", { egg: eggFixture("ptero-egg-vanilla-minecraft.json"), category: "Minecraft" });
  const templateId = imported.json().template.id as string;
  await owner.patch(`/templates/${templateId}`, { fileDenylist: ["*.key"] });
  const alice = await createUserClient(r.t, owner, "alice@example.com", []);
  const aliceId = (await alice.get("/auth/me")).json().user.id as string;
  const created = await owner.post("/servers", {
    name: "Sftp",
    slug: "sftp",
    templateId,
    ownerId: aliceId,
    startup: "manual",
    placement: { mode: "auto" },
    memoryLimitBytes: 2 * 1024 ** 3,
    egg: { variables: { VANILLA_VERSION: "1.21.11" }, acceptEula: true },
  });
  expect(created.statusCode, created.body).toBe(202);
  expect((await waitJob(owner, created.json().jobId)).status).toBe("succeeded");
  const id = created.json().server.id as string;
  return { t: r.t, owner, alice, aliceId, node, id, short: id.replace(/-/g, "").slice(0, 8) };
}

async function sftpAuth(t: TestApp, agent: FakeAgent, body: Record<string, unknown>) {
  const res = await fetch(`${t.baseUrl}/agent/v1/sftp/auth`, {
    method: "POST",
    headers: { authorization: agent.authHeader(), "content-type": "application/json" },
    body: JSON.stringify({ clientIp: "203.0.113.7", sessionId: randomUUID().slice(0, 16), ...body }),
  });
  return { status: res.status, body: (await res.json().catch(() => null)) as Record<string, unknown> | null };
}

async function audits(action: string, outcome?: string) {
  const { rows } = await testPool().query("SELECT actor_id, target_id, outcome, details FROM audit_events WHERE action = $1 AND ($2::text IS NULL OR outcome = $2) ORDER BY id", [action, outcome ?? null]);
  return rows as { actor_id: string | null; target_id: string | null; outcome: string; details: Record<string, unknown> }[];
}

describe("account SSH keys", () => {
  it("adds, lists and removes keys; refuses weak, malformed and duplicate keys", async () => {
    const r = await startWithOwner();
    t = r.t;
    const owner = r.owner;
    const key = ed25519Key("laptop");
    const added = await owner.post("/account/ssh-keys", { name: "Laptop", publicKey: key.line });
    expect(added.statusCode, added.body).toBe(201);
    expect(SshKey.parse(added.json())).toMatchObject({ name: "Laptop", keyType: "ssh-ed25519", fingerprint: key.fingerprint, lastUsedAt: null });
    expect((await owner.post("/account/ssh-keys", { name: "Again", publicKey: key.line })).statusCode).toBe(409);
    const weak = authorizedKey(generateKeyPairSync("rsa", { modulusLength: 2048 }).publicKey);
    const refused = await owner.post("/account/ssh-keys", { name: "Old", publicKey: weak.line });
    expect(refused.statusCode).toBe(400);
    expect(refused.json().error.details.issues[0].path).toBe("publicKey");
    expect((await owner.post("/account/ssh-keys", { name: "Junk", publicKey: "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIA" })).statusCode).toBe(400);
    const list = (await owner.get("/account/ssh-keys")).json() as SshKey[];
    expect(list).toHaveLength(1);
    // Keys are per user: another user cannot see or delete them.
    const other = await createUserClient(r.t, owner, "other@example.com", []);
    expect((await other.get("/account/ssh-keys")).json()).toEqual([]);
    expect((await other.delete(`/account/ssh-keys/${list[0]!.id}`)).statusCode).toBe(404);
    expect((await owner.delete(`/account/ssh-keys/${list[0]!.id}`)).statusCode).toBe(204);
    expect((await owner.get("/account/ssh-keys")).json()).toEqual([]);
    expect((await audits("account.ssh_key.add")).length).toBe(1);
    expect((await audits("account.ssh_key.remove")).length).toBe(1);
    expect(responseLog.filter((x) => x.url.includes("ssh-keys")).every((x) => !x.body.includes(key.line.split(" ")[1]!))).toBe(true);
  });
});

describe("SFTP authentication (POST /agent/v1/sftp/auth)", () => {
  it("authenticates passwords and keys, scoped to the calling node and the user's effective permissions", async () => {
    const { t, owner, alice, aliceId, node, id, short } = await setup();

    // Password login as the owner of the server.
    const ok = await sftpAuth(t, node.agent, { method: "password", username: `alice.${short}`, password: PASSWORD });
    expect(ok.status, JSON.stringify(ok.body)).toBe(200);
    const res = SftpAuthResponse.parse(ok.body);
    expect(res).toMatchObject({ workloadId: id, userId: aliceId, permissions: ["read", "write"], denylist: ["*.key"] });
    expect(res.expiresAt - Date.now()).toBeGreaterThan(14 * 60_000);
    expect((await audits("server.sftp.login", "success"))[0]).toMatchObject({ actor_id: aliceId, target_id: id });

    // Wrong password, unknown user, malformed usernames, wrong server short id: all 401.
    for (const username of [`alice.${short}`, `nobody.${short}`, "alice", `alice.${short}x`, `Alice.${short}`, `alice.00000000`, `../etc.${short}`]) {
      const r = await sftpAuth(t, node.agent, { method: "password", username, password: username === `alice.${short}` ? "wrong" : PASSWORD });
      expect(r.status, username).toBe(401);
    }

    // Public key login; lastUsedAt is recorded.
    const key = ed25519Key();
    expect((await alice.post("/account/ssh-keys", { name: "k", publicKey: key.line })).statusCode).toBe(201);
    const byKey = await sftpAuth(t, node.agent, { method: "publickey", username: `alice.${short}`, publicKey: key.line });
    expect(byKey.status).toBe(200);
    expect(((await alice.get("/account/ssh-keys")).json() as SshKey[])[0]!.lastUsedAt).not.toBeNull();
    const stranger = ed25519Key();
    expect((await sftpAuth(t, node.agent, { method: "publickey", username: `alice.${short}`, publicKey: stranger.line })).status).toBe(401);

    // Another node cannot authenticate users for servers it does not host.
    const other = await connectSimNode(t, owner, { agents, ports: "" });
    expect((await sftpAuth(t, other.agent, { method: "password", username: `alice.${short}`, password: PASSWORD })).status).toBe(401);
    // Unauthenticated callers are refused before anything else.
    const anon = await fetch(`${t.baseUrl}/agent/v1/sftp/auth`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ method: "password", username: `alice.${short}`, password: PASSWORD, clientIp: "x", sessionId: "s" }) });
    expect(anon.status).toBe(401);

    // MFA accounts may only use keys.
    await testPool().query("UPDATE users SET mfa_enabled = true WHERE id = $1", [aliceId]);
    expect((await sftpAuth(t, node.agent, { method: "password", username: `alice.${short}`, password: PASSWORD })).status).toBe(401);
    expect((await sftpAuth(t, node.agent, { method: "publickey", username: `alice.${short}`, publicKey: key.line })).status).toBe(200);
    const mfaFail = (await audits("server.sftp.login", "failed")).find((a) => String(a.details.reason).includes("MFA"));
    expect(mfaFail).toBeDefined();

    // Suspended servers refuse everyone.
    expect((await owner.post(`/servers/${id}/suspend`)).statusCode).toBe(200);
    expect((await sftpAuth(t, node.agent, { method: "publickey", username: `alice.${short}`, publicKey: key.line })).status).toBe(401);
    expect((await owner.post(`/servers/${id}/unsuspend`)).statusCode).toBe(200);

    // Nothing secret in failure audits.
    const failed = await audits("server.sftp.login", "failed");
    expect(JSON.stringify(failed)).not.toContain(PASSWORD);
  });

  it("maps subuser permissions to read/write and requires servers.files.sftp", async () => {
    const { t, owner, alice, node, id, short } = await setup();
    const bob = await createUserClient(t, owner, "bob@example.com", []);
    void bob;
    const add = await alice.post(`/servers/${id}/subusers`, { user: "bob", permissions: ["servers.view", "servers.files.read"] });
    expect(add.statusCode, add.body).toBe(201);
    expect((await sftpAuth(t, node.agent, { method: "password", username: `bob.${short}`, password: PASSWORD })).status).toBe(401);
    expect((await alice.put(`/servers/${id}/subusers/${add.json().id}`, { permissions: ["servers.view", "servers.files.read", "servers.files.sftp"] })).statusCode).toBe(200);
    const ro = await sftpAuth(t, node.agent, { method: "password", username: `bob.${short}`, password: PASSWORD });
    expect(ro.status).toBe(200);
    expect(ro.body).toMatchObject({ permissions: ["read"], denylist: ["*.key"] });
    // The installation owner is an administrator: no denylist.
    const admin = await sftpAuth(t, node.agent, { method: "password", username: `owner.${short}`, password: "correct horse battery staple" });
    expect(admin.status).toBe(200);
    expect(admin.body).toMatchObject({ permissions: ["read", "write"], denylist: [] });
  });

  it("rate-limits failed attempts per client and username (successful logins do not count)", async () => {
    const { t, node, short } = await setup();
    for (let i = 0; i < 12; i++) expect((await sftpAuth(t, node.agent, { method: "password", username: `alice.${short}`, password: PASSWORD })).status).toBe(200);
    const statuses: number[] = [];
    for (let i = 0; i < 11; i++) statuses.push((await sftpAuth(t, node.agent, { method: "password", username: `alice.${short}`, password: "wrong" })).status);
    expect(statuses.slice(0, 10).every((s) => s === 401)).toBe(true);
    expect(statuses[10]).toBe(429);
    // Even the right password is refused while the client is limited.
    expect((await sftpAuth(t, node.agent, { method: "password", username: `alice.${short}`, password: PASSWORD })).status).toBe(429);
  });

  it("records sftp.activity events on the server's activity log", async () => {
    const { alice, aliceId, node, id } = await setup();
    node.agent.send({
      t: "event",
      ts: Date.now(),
      event: "sftp.activity",
      data: {
        workloadId: id,
        userId: aliceId,
        sessionId: "sess-1",
        clientIp: "203.0.113.7",
        actions: [
          { action: "upload", path: "plugins/x.jar", ts: Date.now() },
          { action: "rename", path: "a.txt", to: "b.txt", ts: Date.now() },
          { action: "delete", path: "old.log", ts: Date.now() },
        ],
      },
    });
    await poll(async () => (await audits("server.sftp.delete")).length === 1);
    const activity = (await alice.get(`/servers/${id}/activity?limit=50`)).json().items as { action: string; details: Record<string, unknown> }[];
    expect(activity.map((a) => a.action)).toEqual(expect.arrayContaining(["server.sftp.upload", "server.sftp.rename", "server.sftp.delete"]));
    expect(activity.find((a) => a.action === "server.sftp.rename")?.details).toMatchObject({ path: "a.txt", to: "b.txt", sessionId: "sess-1" });
    // Events for workloads the node does not own are dropped.
    node.agent.send({ t: "event", ts: Date.now(), event: "sftp.activity", data: { workloadId: randomUUID(), userId: aliceId, sessionId: "s", clientIp: "x", actions: [{ action: "mkdir", path: "x", ts: Date.now() }] } });
    await new Promise((r) => setTimeout(r, 300));
    expect(await audits("server.sftp.mkdir")).toEqual([]);
  });
});
