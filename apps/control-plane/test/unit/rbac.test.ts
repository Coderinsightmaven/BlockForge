import { BUILTIN_ROLES, type Permission, type ScopeType } from "@blockforge/contracts";
import { describe, expect, it } from "vitest";
import {
  authorize,
  hasPermissionAnywhere,
  holdsPrivilegedRole,
  isOwner,
  isPrivilegedRole,
  permittedScopes,
  scopeCovers,
  summarizePermissions,
  type Grant,
  type Principal,
  type Resource,
} from "../../src/rbac/authorize.js";

const NODE_A = "00000000-0000-4000-8000-0000000000a1";
const NODE_B = "00000000-0000-4000-8000-0000000000b1";
const NET_1 = "00000000-0000-4000-8000-000000000e01";
const SRV_A1 = "00000000-0000-4000-8000-00000000a001"; // on node A, in network 1
const SRV_A2 = "00000000-0000-4000-8000-00000000a002"; // on node A, no network
const SRV_B1 = "00000000-0000-4000-8000-00000000b001"; // on node B, in network 1

const server = (id: string, nodeId: string, networkId: string | null): Resource => ({ type: "server", id, nodeId, networkId });
const sA1 = server(SRV_A1, NODE_A, NET_1);
const sA2 = server(SRV_A2, NODE_A, null);
const sB1 = server(SRV_B1, NODE_B, NET_1);

function grant(roleKey: keyof typeof BUILTIN_ROLES, scopeType: ScopeType, scopeId: string | null): Grant {
  return { bindingId: `${roleKey}-${scopeType}-${scopeId}`, roleKey, scopeType, scopeId, permissions: new Set<Permission>(BUILTIN_ROLES[roleKey].permissions) };
}
const principal = (...grants: Grant[]): Principal => ({ userId: "u", email: "u@example.com", username: "u-user", displayName: "U", grants });

describe("scope resolution", () => {
  it("global covers everything", () => {
    for (const r of [{ type: "global" } as const, { type: "node", id: NODE_A } as const, sA1, { type: "network", id: NET_1 } as const]) {
      expect(scopeCovers({ scopeType: "global", scopeId: null }, r)).toBe(true);
    }
  });

  it("node grants cover the node and its servers only", () => {
    const g = { scopeType: "node" as const, scopeId: NODE_A };
    expect(scopeCovers(g, { type: "node", id: NODE_A })).toBe(true);
    expect(scopeCovers(g, sA1)).toBe(true);
    expect(scopeCovers(g, sA2)).toBe(true);
    expect(scopeCovers(g, { type: "node", id: NODE_B })).toBe(false);
    expect(scopeCovers(g, sB1)).toBe(false);
    expect(scopeCovers(g, { type: "global" })).toBe(false);
    expect(scopeCovers(g, { type: "network", id: NET_1 })).toBe(false);
  });

  it("network grants cover member servers on any node", () => {
    const g = { scopeType: "network" as const, scopeId: NET_1 };
    expect(scopeCovers(g, sA1)).toBe(true);
    expect(scopeCovers(g, sB1)).toBe(true);
    expect(scopeCovers(g, sA2)).toBe(false);
    expect(scopeCovers(g, { type: "node", id: NODE_A })).toBe(false);
  });

  it("server grants cover exactly that server", () => {
    const g = { scopeType: "server" as const, scopeId: SRV_A1 };
    expect(scopeCovers(g, sA1)).toBe(true);
    expect(scopeCovers(g, sA2)).toBe(false);
    expect(scopeCovers(g, { type: "node", id: NODE_A })).toBe(false);
  });
});

describe("authorize", () => {
  it("denies cross-scope access for a server admin", () => {
    const p = principal(grant("server_admin", "server", SRV_A1));
    expect(authorize(p, "servers.control", sA1)).toBe(true);
    expect(authorize(p, "servers.control", sA2)).toBe(false);
    expect(authorize(p, "servers.control", sB1)).toBe(false);
    expect(authorize(p, "nodes.view", { type: "node", id: NODE_A })).toBe(false);
    expect(authorize(p, "users.view", { type: "global" })).toBe(false);
  });

  it("node-scoped infra admin reaches servers on the node but not other nodes", () => {
    const p = principal(grant("infra_admin", "node", NODE_A));
    expect(authorize(p, "nodes.manage", { type: "node", id: NODE_A })).toBe(true);
    expect(authorize(p, "servers.control", sA2)).toBe(true);
    expect(authorize(p, "nodes.manage", { type: "node", id: NODE_B })).toBe(false);
    expect(authorize(p, "servers.control", sB1)).toBe(false);
  });

  it("ignores permissions granted at a scope type where they are not allowed", () => {
    // infra_admin carries nodes.enroll, which may only be granted globally.
    const p = principal(grant("infra_admin", "node", NODE_A));
    expect(authorize(p, "nodes.enroll", { type: "global" })).toBe(false);
    expect(authorize(p, "nodes.enroll", { type: "node", id: NODE_A })).toBe(false);
    expect(hasPermissionAnywhere(p, "nodes.enroll")).toBe(false);
    expect(hasPermissionAnywhere(p, "monitoring.view")).toBe(true);
  });

  it("moderators cannot send raw console commands", () => {
    const p = principal(grant("moderator", "global", null));
    expect(authorize(p, "servers.console.view", sA1)).toBe(true);
    expect(authorize(p, "servers.console.send", sA1)).toBe(false);
  });

  it("observers are read-only and cannot see users or audit", () => {
    const p = principal(grant("observer", "global", null));
    expect(authorize(p, "servers.view", sA1)).toBe(true);
    expect(authorize(p, "servers.control", sA1)).toBe(false);
    expect(authorize(p, "users.view", { type: "global" })).toBe(false);
    expect(authorize(p, "audit.view", { type: "global" })).toBe(false);
  });

  it("permittedScopes collects grant targets per permission", () => {
    const p = principal(grant("infra_admin", "node", NODE_A), grant("server_admin", "server", SRV_B1), grant("network_admin", "network", NET_1));
    const s = permittedScopes(p, "monitoring.view");
    expect(s.all).toBe(false);
    expect([...s.nodeIds]).toEqual([NODE_A]);
    expect([...s.serverIds]).toEqual([SRV_B1]);
    expect([...s.networkIds]).toEqual([NET_1]);
    expect(permittedScopes(principal(grant("admin", "global", null)), "monitoring.view").all).toBe(true);
  });
});

describe("privileged roles", () => {
  it("identifies owner/admin as privileged and detects owners", () => {
    expect(isPrivilegedRole("owner")).toBe(true);
    expect(isPrivilegedRole("admin")).toBe(true);
    expect(isPrivilegedRole("infra_admin")).toBe(false);
    expect(isOwner(principal(grant("owner", "global", null)))).toBe(true);
    expect(isOwner(principal(grant("admin", "global", null)))).toBe(false);
    expect(holdsPrivilegedRole([{ roleKey: "observer" }, { roleKey: "admin" }])).toBe(true);
  });

  it("summarises global and scoped permissions for /auth/me", () => {
    const s = summarizePermissions(principal(grant("observer", "global", null), grant("server_admin", "server", SRV_A1)));
    expect(s.globalPermissions).toContain("servers.view");
    expect(s.globalPermissions).not.toContain("servers.control");
    const scoped = s.scopedPermissions.find((x) => x.scopeId === SRV_A1);
    expect(scoped?.permissions).toContain("servers.control");
  });
});
