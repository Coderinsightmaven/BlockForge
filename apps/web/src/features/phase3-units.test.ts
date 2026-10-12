import { QueryClient } from "@tanstack/react-query";
import { describe, expect, it } from "vitest";
import { SERVER_OWNER_PERMISSIONS } from "@blockforge/contracts";
import type { InfiniteData } from "@tanstack/react-query";
import type { Page, Server } from "@blockforge/contracts";
import { SERVER_ID, makeNode, makeServer } from "@/test/fixtures";
import { qk } from "@/lib/query-keys";
import {
  applyServerEvent,
  applyServerSample,
  mergeServerLatest,
  upsertServerInCache,
} from "@/lib/server-cache";
import { cpuView, memoryView, playersView } from "@/lib/server-metrics";
import { nodeAddresses, parsePortInput } from "./nodes/node-allocations";
import { mergeJobLogs } from "./servers/server-common";
import { allocationAddress, canAddAllocation } from "./servers/tabs/network-tab";
import { buildPatch } from "./servers/tabs/settings-tab";
import { checkPublicKey } from "./settings/ssh-keys";
import { hasBlockingIssues, parseEggJson } from "./templates/templates-page";
import { usernameFromEmail } from "./users/user-dialogs";

const sample = (ts: number, extra: Record<string, unknown> = {}) => ({
  workloadId: SERVER_ID,
  ts,
  running: true,
  ...extra,
});

describe("allocation range parsing (contract expandPortList)", () => {
  it("expands ports and ranges, de-duplicated and sorted", () => {
    expect(parsePortInput("25570-25572,25565, 25571")).toEqual({
      ports: [25565, 25570, 25571, 25572],
      error: null,
    });
    expect(parsePortInput("25565").ports).toEqual([25565]);
  });
  it("rejects malformed lists, reversed or out-of-range ranges and > 1000 ports", () => {
    expect(parsePortInput("").error).toBeTruthy();
    expect(parsePortInput("25565-").error).toMatch(/ports and ranges/);
    expect(parsePortInput("abc").error).toMatch(/ports and ranges/);
    expect(parsePortInput("25600-25570").error).toMatch(/invalid range/);
    expect(parsePortInput("0-10").error).toMatch(/invalid range/);
    expect(parsePortInput("70000").error).toMatch(/invalid range/);
    expect(parsePortInput("1000-2500").error).toMatch(/1000 ports/);
  });
  it("offers the node's own addresses (no loopback / link-local)", () => {
    const node = makeNode();
    const withFacts = {
      ...node,
      facts: {
        interfaces: [
          { name: "lo", addresses: ["127.0.0.1/8", "::1/128"] },
          { name: "eth0", addresses: ["10.10.10.240/24", "fe80::1/64", "2001:db8::5/64"] },
        ],
      },
    } as unknown as typeof node;
    expect(nodeAddresses(withFacts)).toEqual(["0.0.0.0", "10.10.10.240", "2001:db8::5"]);
  });
  it("formats addresses and enforces the additional-allocation limit", () => {
    expect(allocationAddress({ alias: null, ip: "2001:db8::5", port: 25565 })).toBe("[2001:db8::5]:25565");
    expect(allocationAddress({ alias: "play.example.com", ip: "10.0.0.1", port: 25565 })).toBe(
      "play.example.com:25565",
    );
    const a = (primary: boolean) =>
      ({ primary }) as unknown as Parameters<typeof canAddAllocation>[0][number];
    expect(canAddAllocation([a(true), a(false)], 1)).toBe(false);
    expect(canAddAllocation([a(true)], 1)).toBe(true);
    expect(canAddAllocation([a(true)], 0)).toBe(false);
  });
});

describe("workload metrics semantics", () => {
  it("treats cpuPct as per-core: % of the limit, or cores without one", () => {
    expect(cpuView({ cpuPct: 150 }, 2000)).toMatchObject({
      pctOfLimit: 75,
      cores: 1.5,
      text: "75% of 2 cores",
    });
    expect(cpuView({ cpuPct: 250 }, null)).toMatchObject({
      pctOfLimit: null,
      cores: 2.5,
      text: "2.5 cores (no limit)",
    });
    expect(cpuView(null, 2000).text).toBe("No data");
  });
  it("memory uses the sample's limit when reported, players only for Minecraft", () => {
    const s = makeServer({
      latest: sample(1, { memoryUsageBytes: 1024 ** 3, memoryLimitBytes: 4 * 1024 ** 3 }),
    });
    expect(memoryView(s)).toEqual({ used: 1024 ** 3, limit: 4 * 1024 ** 3, pct: 25 });
    const mc = makeServer({
      latest: sample(1, { minecraft: { playersOnline: 3, playersMax: 20, latencyMs: 2, playerSample: [] } }),
    });
    expect(playersView(mc)).toEqual({ online: 3, max: 20 });
    expect(playersView({ ...mc, game: "other" })).toBeNull();
  });
});

describe("server cache", () => {
  const list = (servers: Server[]): InfiniteData<Page<Server>> => ({
    pages: [{ items: servers, nextCursor: null }],
    pageParams: [null],
  });

  it("keeps a newer live sample over an older REST copy", () => {
    const cached = makeServer({ latest: sample(2000) });
    expect(mergeServerLatest(makeServer({ name: "Renamed", latest: sample(1000) }), cached)).toMatchObject({
      name: "Renamed",
      latest: { ts: 2000 },
    });
  });

  it("server.updated events keep the cached per-user fields", () => {
    const qc = new QueryClient();
    const mine = makeServer({ myPermissions: [...SERVER_OWNER_PERMISSIONS] });
    qc.setQueryData(qk.servers.detail(SERVER_ID), mine);
    qc.setQueryData(qk.servers.list("mine", ""), list([mine]));
    applyServerEvent(qc, makeServer({ state: "stopping", myPermissions: ["servers.view"], sftp: null }));
    const detail = qc.getQueryData<Server>(qk.servers.detail(SERVER_ID))!;
    expect(detail.state).toBe("stopping");
    expect(detail.myPermissions).toEqual([...SERVER_OWNER_PERMISSIONS]);
    expect(
      qc.getQueryData<InfiniteData<Page<Server>>>(qk.servers.list("mine", ""))!.pages[0]!.items[0]!.state,
    ).toBe("stopping");
  });

  it("applies samples only when newer, and REST DTOs replace per-user fields", () => {
    const qc = new QueryClient();
    qc.setQueryData(qk.servers.detail(SERVER_ID), makeServer({ latest: sample(5000) }));
    applyServerSample(qc, SERVER_ID, sample(4000, { cpuPct: 99 }));
    expect(qc.getQueryData<Server>(qk.servers.detail(SERVER_ID))!.latest?.ts).toBe(5000);
    applyServerSample(qc, SERVER_ID, sample(6000, { cpuPct: 12 }));
    expect(qc.getQueryData<Server>(qk.servers.detail(SERVER_ID))!.latest?.cpuPct).toBe(12);
    upsertServerInCache(qc, makeServer({ myPermissions: ["servers.view"] }));
    expect(qc.getQueryData<Server>(qk.servers.detail(SERVER_ID))!.myPermissions).toEqual(["servers.view"]);
  });
});

describe("job logs", () => {
  it("merge by id (REST backfill + live events)", () => {
    const l = (id: number) => ({ id, ts: id, level: "info" as const, message: `m${id}` });
    expect(mergeJobLogs([l(1), l(2)], [l(2), l(4), l(3)]).map((x) => x.id)).toEqual([1, 2, 3, 4]);
  });
});

describe("server build patch (admin)", () => {
  const s = makeServer({
    memoryLimitBytes: 4096 * 1024 ** 2,
    cpuLimitMillicores: 2000,
    storageQuotaBytes: null,
    allocationLimit: 2,
    backupLimit: 3,
  });
  const form = {
    memoryMiB: "4096",
    cpuCores: "2",
    diskGiB: "",
    allocationLimit: "2",
    backupLimit: "3",
    startup: "auto" as const,
    restartMode: "on-failure" as const,
    maxRetries: "3",
  };
  it("sends only changed fields", () => {
    expect(buildPatch(s, form)).toEqual({ patch: {}, errors: {} });
    expect(buildPatch(s, { ...form, memoryMiB: "8192", cpuCores: "", diskGiB: "50" }).patch).toEqual({
      memoryLimitBytes: 8192 * 1024 ** 2,
      cpuLimitMillicores: null,
      storageQuotaBytes: 50 * 1024 ** 3,
    });
  });
  it("validates limits", () => {
    const { errors } = buildPatch(s, { ...form, memoryMiB: "128", cpuCores: "0.1", allocationLimit: "99" });
    expect(Object.keys(errors).sort()).toEqual(["allocationLimit", "cpuCores", "memoryMiB"]);
  });
});

describe("templates import", () => {
  it("parses egg JSON with clear errors", () => {
    expect(parseEggJson('{"meta":{"version":"PTDL_v2"},"name":"Terraria"}').egg).toMatchObject({
      name: "Terraria",
    });
    expect(parseEggJson("").error).toMatch(/Paste/);
    expect(parseEggJson("[1,2]").error).toMatch(/object/);
    expect(parseEggJson("{oops").error).toMatch(/Not valid JSON/);
    expect(parseEggJson(" ".repeat(600 * 1024) + "{}").error).toMatch(/too large/);
  });
  it("blocks the import while errors exist", () => {
    const t = {} as NonNullable<Parameters<typeof hasBlockingIssues>[0]>["template"];
    expect(hasBlockingIssues(null)).toBe(true);
    expect(hasBlockingIssues({ template: null, issues: [] })).toBe(true);
    expect(
      hasBlockingIssues({ template: t, issues: [{ severity: "warning", code: "x", message: "m" }] }),
    ).toBe(false);
    expect(hasBlockingIssues({ template: t, issues: [{ severity: "error", code: "x", message: "m" }] })).toBe(
      true,
    );
  });
});

describe("account", () => {
  it("checks pasted SSH public keys", () => {
    expect(
      checkPublicKey(
        "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIOMqqnkVzrm0SdG6UOoqKLsabgH5C9okWi0dh2l9GKJl me@laptop",
      ),
    ).toEqual({
      error: null,
      comment: "me@laptop",
    });
    expect(checkPublicKey("-----BEGIN OPENSSH PRIVATE KEY-----").error).toMatch(/private key/);
    expect(checkPublicKey("ssh-dss AAAAB3NzaC1kc3MAAACBAP").error).toMatch(/Unsupported/);
    expect(checkPublicKey("ssh-ed25519 not*base64").error).toMatch(/base64/);
  });
  it("suggests usernames that satisfy the contract", () => {
    expect(usernameFromEmail("Jane.Doe+mc@example.com")).toBe("jane-doe-mc");
    expect(usernameFromEmail("_x@example.com")).toBe("");
    expect(usernameFromEmail("bob@example.com")).toBe("bob");
  });
});
