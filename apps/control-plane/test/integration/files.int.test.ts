import { createHash } from "node:crypto";
import { FileArchiveResponse, FileContentResponse, FileListResponse, TransferUrlResponse } from "@blockforge/contracts";
import { afterEach, describe, expect, it } from "vitest";
import { createUserClient, responseLog, startWithOwner, type ApiClient, type TestApp } from "../support/app.js";
import { testPool } from "../support/db.js";
import type { FakeAgent } from "../support/fake-agent.js";
import { connectSimNode, eggFixture, waitJob, type SimNodeHandle } from "../support/panel.js";

let t: TestApp | null = null;
const agents: FakeAgent[] = [];
afterEach(async () => {
  for (const a of agents.splice(0)) await a.close().catch(() => undefined);
  await t?.close();
  t = null;
});

const SECRET = "s3cr3t-forwarding-value-abcdef";

/**
 * An egg server (manual startup) owned by alice, who has no administrator role: the template
 * denylist and secret redaction apply to her; the installation owner bypasses both.
 */
async function setup(): Promise<{ t: TestApp; owner: ApiClient; alice: ApiClient; node: SimNodeHandle; id: string }> {
  const r = await startWithOwner({ background: true });
  t = r.t;
  const owner = r.owner;
  const node = await connectSimNode(r.t, owner, { agents, sim: { installCreates: { "server.jar": "jar" } } });
  const imported = await owner.post("/templates/import", { egg: eggFixture("ptero-egg-vanilla-minecraft.json"), category: "Minecraft" });
  expect(imported.statusCode, imported.body).toBe(201);
  const templateId = imported.json().template.id as string;
  const patched = await owner.patch(`/templates/${templateId}`, { fileDenylist: ["secrets/", "*.key", "!public.key"] });
  expect(patched.statusCode, patched.body).toBe(200);
  const alice = await createUserClient(r.t, owner, "alice@example.com", []);
  const aliceId = (await alice.get("/auth/me")).json().user.id as string;
  const created = await owner.post("/servers", {
    name: "Files",
    slug: "files",
    templateId,
    ownerId: aliceId,
    startup: "manual",
    placement: { mode: "auto" },
    memoryLimitBytes: 2 * 1024 ** 3,
    egg: { variables: { VANILLA_VERSION: "1.21.11" } },
  });
  expect(created.statusCode, created.body).toBe(202);
  const id = created.json().server.id as string;
  expect((await waitJob(owner, created.json().jobId)).status).toBe("succeeded");
  node.sim.put(id, "secrets/token.txt", "do not read");
  node.sim.put(id, "server.key", "private");
  node.sim.put(id, "public.key", "public");
  node.sim.put(id, "forwarding.secret", SECRET);
  node.sim.put(id, "config/paper-global.yml", `proxies:\n  velocity:\n    enabled: true\n    online-mode: true\n    secret: '${SECRET}'\n`);
  node.sim.put(id, "plugins/Essentials/config.yml", "motd: hello\n");
  return { t: r.t, owner, alice, node, id };
}

describe("file manager", () => {
  it("lists, reads, writes with optimistic concurrency and enforces the denylist for non-administrators", async () => {
    const { owner, alice, node, id } = await setup();

    const list = FileListResponse.parse((await alice.get(`/servers/${id}/files/list`)).json());
    const names = list.entries.map((e) => e.name).sort();
    // Denied entries are listed (Wings semantics); their contents are protected.
    expect(names).toEqual(expect.arrayContaining(["secrets", "server.key", "public.key", "server.jar", "server.properties", "config", "plugins"]));

    const denied = await alice.get(`/servers/${id}/files/contents?path=server.key`);
    expect(denied.statusCode).toBe(403);
    expect(denied.json().error.code).toBe("PATH_DENIED");
    expect(denied.body).not.toContain("private");
    expect((await alice.get(`/servers/${id}/files/contents?path=secrets/token.txt`)).json().error.code).toBe("PATH_DENIED");
    expect((await alice.get(`/servers/${id}/files/list?path=secrets`)).json().error.code).toBe("PATH_DENIED");
    expect((await alice.get(`/servers/${id}/files/contents?path=public.key`)).statusCode).toBe(200);
    expect((await alice.post(`/servers/${id}/files/delete`, { paths: ["server.key"] })).json().error.code).toBe("PATH_DENIED");
    expect((await alice.post(`/servers/${id}/files/rename`, { renames: [{ from: "public.key", to: "secrets/x" }] })).json().error.code).toBe("PATH_DENIED");
    expect((await alice.get(`/servers/${id}/files/download-url?path=server.key`)).json().error.code).toBe("PATH_DENIED");
    const search = (await alice.get(`/servers/${id}/files/search?q=key`)).json() as { matches: { path: string }[] };
    expect(search.matches.map((m) => m.path)).toEqual(["public.key"]);
    // The installation owner (servers.admin) is not bound by the template denylist.
    expect((await owner.get(`/servers/${id}/files/contents?path=server.key`)).json().content).toBe("private");

    // Read → write with the read sha256; a stale sha256 is a conflict.
    const read = FileContentResponse.parse((await alice.get(`/servers/${id}/files/contents?path=plugins/Essentials/config.yml`)).json());
    expect(read).toMatchObject({ content: "motd: hello\n", encoding: "utf8", redacted: false, truncated: false });
    const ok = await alice.put(`/servers/${id}/files/contents`, { path: "plugins/Essentials/config.yml", content: "motd: <b>bye</b>\n", baseSha256: read.sha256 });
    expect(ok.statusCode, ok.body).toBe(200);
    expect(node.sim.read(id, "plugins/Essentials/config.yml")).toBe("motd: <b>bye</b>\n");
    const stale = await alice.put(`/servers/${id}/files/contents`, { path: "plugins/Essentials/config.yml", content: "x", baseSha256: read.sha256 });
    expect(stale.statusCode).toBe(409);
    expect(stale.json().error.code).toBe("CONFLICT");
    const mustNotExist = await alice.put(`/servers/${id}/files/contents`, { path: "plugins/Essentials/config.yml", content: "x", baseSha256: null });
    expect(mustNotExist.json().error.code).toBe("CONFLICT");
    expect((await alice.put(`/servers/${id}/files/contents`, { path: "new/dir/file.txt", content: "hi", baseSha256: null })).statusCode).toBe(200);
    expect((await alice.get(`/servers/${id}/files/contents?path=nope.txt`)).statusCode).toBe(404);
    // Path traversal never reaches the agent.
    expect((await alice.get(`/servers/${id}/files/contents?path=../etc/passwd`)).statusCode).toBe(400);
    expect((await alice.get(`/servers/${id}/files/contents?path=/etc/passwd`)).statusCode).toBe(400);
  });

  it("redacts proxy secrets for users without secrets.read and refuses to save redacted files", async () => {
    const { owner, alice, id } = await setup();
    const fwd = FileContentResponse.parse((await alice.get(`/servers/${id}/files/contents?path=forwarding.secret`)).json());
    expect(fwd.redacted).toBe(true);
    expect(fwd.content).not.toContain(SECRET);
    const paper = FileContentResponse.parse((await alice.get(`/servers/${id}/files/contents?path=config/paper-global.yml`)).json());
    expect(paper.redacted).toBe(true);
    expect(paper.content).not.toContain(SECRET);
    expect(paper.content).toContain("online-mode: true");
    const save = await alice.put(`/servers/${id}/files/contents`, { path: "config/paper-global.yml", content: paper.content, baseSha256: paper.sha256 });
    expect(save.statusCode).toBe(403);
    expect(save.json().error.code).toBe("REDACTED_CONTENT");
    const dl = await alice.get(`/servers/${id}/files/download-url?path=forwarding.secret`);
    expect(dl.json().error.code).toBe("REDACTED_CONTENT");
    expect((await alice.post(`/servers/${id}/files/delete`, { paths: ["forwarding.secret"] })).json().error.code).toBe("REDACTED_CONTENT");
    // The owner holds secrets.read.
    const plain = FileContentResponse.parse((await owner.get(`/servers/${id}/files/contents?path=forwarding.secret`)).json());
    expect(plain).toMatchObject({ content: SECRET, redacted: false });
    expect(responseLog.filter((r) => r.url.includes("/files/") && r.status === 200 && !r.url.includes("forwarding.secret")).every((r) => !r.body.includes(SECRET))).toBe(true);
  });

  it("renames, copies, deletes, creates directories, chmods and runs archive jobs", async () => {
    const { alice, node, id } = await setup();
    expect((await alice.post(`/servers/${id}/files/mkdir`, { path: "backups" })).statusCode).toBe(204);
    expect((await alice.post(`/servers/${id}/files/mkdir`, { path: "backups" })).json().error.code).toBe("CONFLICT");
    const copy = await alice.post(`/servers/${id}/files/copy`, { path: "server.properties" });
    expect(copy.statusCode).toBe(200);
    expect(copy.json()).toEqual({ path: "server copy.properties" });
    expect((await alice.post(`/servers/${id}/files/copy`, { path: "server.properties" })).json()).toEqual({ path: "server copy 2.properties" });
    expect((await alice.post(`/servers/${id}/files/rename`, { renames: [{ from: "server copy.properties", to: "backups/server.properties" }] })).statusCode).toBe(204);
    expect(node.sim.read(id, "backups/server.properties")).not.toBeNull();
    expect((await alice.post(`/servers/${id}/files/chmod`, { files: [{ path: "backups/server.properties", mode: "600" }] })).statusCode).toBe(204);
    expect(node.sim.files(id).get("backups/server.properties")?.mode).toBe(0o600);
    expect((await alice.post(`/servers/${id}/files/delete`, { paths: ["server copy 2.properties"] })).statusCode).toBe(204);
    expect(node.sim.read(id, "server copy 2.properties")).toBeNull();

    const compress = await alice.post(`/servers/${id}/files/compress`, { root: "", paths: ["plugins", "backups"], format: "tar.gz" });
    expect(compress.statusCode, compress.body).toBe(200);
    const archive = FileArchiveResponse.parse(compress.json());
    expect(archive.path).toMatch(/^archive-\d{8}T\d{6}Z\.tar\.gz$/);
    expect(archive.entries).toBe(5);
    const decompress = await alice.post(`/servers/${id}/files/decompress`, { path: archive.path, destination: "restored" });
    expect(decompress.statusCode, decompress.body).toBe(200);
    expect(FileArchiveResponse.parse(decompress.json())).toMatchObject({ path: "restored", entries: 1 });
    expect(node.sim.read(id, "restored/extracted.txt")).toBe("extracted");
    // Archiving a denied path is refused before any job is queued.
    expect((await alice.post(`/servers/${id}/files/compress`, { root: "", paths: ["secrets"], format: "zip" })).json().error.code).toBe("PATH_DENIED");

    const { rows } = await testPool().query("SELECT action FROM audit_events WHERE target_id = $1 AND action LIKE 'server.file.%'", [id]);
    expect(new Set(rows.map((r) => r.action))).toEqual(
      new Set(["server.file.mkdir", "server.file.copy", "server.file.rename", "server.file.chmod", "server.file.delete", "server.file.compress", "server.file.decompress"]),
    );
  });

  it("streams uploads and downloads through single-use, session-bound transfer URLs", async () => {
    const { t, alice, owner, node, id } = await setup();
    const payload = Buffer.from("x".repeat(200_000) + "end");
    const url = TransferUrlResponse.parse((await alice.post(`/servers/${id}/files/upload-url`, { directory: "plugins", fileName: "big.jar", size: payload.length })).json());
    expect(url.url).toMatch(/^\/api\/v1\/transfers\/[A-Za-z0-9_-]{43}$/);
    expect(url.expiresAt - Date.now()).toBeLessThanOrEqual(5 * 60_000);

    // Another session cannot use the token (and does not consume it).
    const other = await t.app.inject({ method: "PUT", url: url.url, headers: { cookie: owner.cookieHeader(), "x-csrf-token": owner.csrf ?? "", "content-type": "application/octet-stream" }, payload });
    expect(other.statusCode).toBe(404);
    // No CSRF header needed: the session-bound single-use token authorises the upload.
    const up = await t.app.inject({ method: "PUT", url: url.url, headers: { cookie: alice.cookieHeader(), "content-type": "application/octet-stream" }, payload });
    expect(up.statusCode, up.body).toBe(200);
    expect(up.json()).toEqual({ bytes: payload.length, sha256: createHash("sha256").update(payload).digest("hex") });
    expect(node.sim.files(id).get("plugins/big.jar")?.data.equals(payload)).toBe(true);
    const reuse = await t.app.inject({ method: "PUT", url: url.url, headers: { cookie: alice.cookieHeader(), "content-type": "application/octet-stream" }, payload });
    expect(reuse.statusCode).toBe(404);
    // A foreign Origin is still refused.
    const url2 = TransferUrlResponse.parse((await alice.post(`/servers/${id}/files/upload-url`, { directory: "", fileName: "a.txt", size: 3 })).json());
    const foreign = await t.app.inject({ method: "PUT", url: url2.url, headers: { cookie: alice.cookieHeader(), origin: "https://evil.example", "content-type": "application/octet-stream" }, payload: Buffer.from("abc") });
    expect(foreign.statusCode).toBe(403);
    // Uploading into a denied directory is refused when the URL is requested.
    expect((await alice.post(`/servers/${id}/files/upload-url`, { directory: "secrets", fileName: "x.txt", size: 1 })).json().error.code).toBe("PATH_DENIED");

    const down = TransferUrlResponse.parse((await alice.get(`/servers/${id}/files/download-url?path=plugins/big.jar`)).json());
    const got = await t.app.inject({ method: "GET", url: down.url, headers: { cookie: alice.cookieHeader() } });
    expect(got.statusCode).toBe(200);
    expect(got.headers["content-disposition"]).toBe('attachment; filename="big.jar"');
    expect(got.rawPayload.equals(payload)).toBe(true);
    expect((await t.app.inject({ method: "GET", url: down.url, headers: { cookie: alice.cookieHeader() } })).statusCode).toBe(404);

    const missing = TransferUrlResponse.parse((await alice.get(`/servers/${id}/files/download-url?path=missing.bin`)).json());
    expect((await t.app.inject({ method: "GET", url: missing.url, headers: { cookie: alice.cookieHeader() } })).statusCode).toBe(404);

    const { rows } = await testPool().query("SELECT action, details FROM audit_events WHERE target_id = $1 AND action IN ('server.file.upload','server.file.download') ORDER BY id", [id]);
    expect(rows.map((r) => r.action)).toEqual(["server.file.upload", "server.file.download"]);
    expect(rows[0].details).toMatchObject({ path: "plugins/big.jar", bytes: payload.length });
  });

  it("requires file permissions on the server", async () => {
    const { t, owner, id } = await setup();
    const viewer = await createUserClient(t, owner, "viewer@example.com", []);
    expect((await viewer.get(`/servers/${id}/files/list`)).statusCode).toBe(404);
    const add = await owner.post(`/servers/${id}/subusers`, { user: "viewer", permissions: ["servers.view", "servers.files.read"] });
    expect(add.statusCode, add.body).toBe(201);
    expect((await viewer.get(`/servers/${id}/files/list`)).statusCode).toBe(200);
    expect((await viewer.put(`/servers/${id}/files/contents`, { path: "a.txt", content: "x" })).statusCode).toBe(403);
    expect((await viewer.post(`/servers/${id}/files/upload-url`, { directory: "", fileName: "a.txt", size: 1 })).statusCode).toBe(403);
  });
});
