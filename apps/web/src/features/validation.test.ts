import { describe, expect, it } from "vitest";
import { BUILTIN_ROLES } from "@blockforge/contracts";
import { makeMe } from "@/test/fixtures";
import { can, canAny, hasGlobal, isOwner } from "@/lib/permissions";
import { navAvailability, NAV_ITEMS } from "@/components/shell/nav-items";
import { parseRecipients, validateWebhookUrl } from "./alerts/channels-tab";
import { toAuditFilters } from "./audit/audit-page";
import { groupSecret } from "./settings/settings-page";
import { applicablePermissions } from "./users/user-dialogs";

describe("notification channel validation", () => {
  it("requires https for Discord and rejects credentials in URLs", () => {
    expect(validateWebhookUrl("discord", "https://discord.com/api/webhooks/1/abc")).toBeNull();
    expect(validateWebhookUrl("discord", "http://discord.com/api/webhooks/1/abc")).toMatch(/https/);
    expect(validateWebhookUrl("webhook", "http://hooks.internal.example/x")).toBeNull();
    expect(validateWebhookUrl("webhook", "ftp://x")).toMatch(/http/);
    expect(validateWebhookUrl("webhook", "https://user:pw@example.com")).toMatch(/credentials/);
    expect(validateWebhookUrl("webhook", "not a url")).toMatch(/full URL/);
  });
  it("parses email recipients", () => {
    expect(parseRecipients("a@example.com, B@example.com\nb@example.com")).toEqual({
      to: ["a@example.com", "b@example.com"],
      error: null,
    });
    expect(parseRecipients("").error).toMatch(/at least one/);
    expect(parseRecipients("a@example.com, nope").error).toMatch(/nope/);
  });
});

describe("audit filters", () => {
  it("drops empty fields and validates the time window", () => {
    expect(
      toAuditFilters({
        action: " node.revoke ",
        actorId: "__any",
        targetType: "",
        targetId: "",
        from: "",
        to: "",
      }),
    ).toEqual({
      filters: { action: "node.revoke" },
      error: null,
    });
    const r = toAuditFilters({
      action: "",
      actorId: "u1",
      targetType: "node",
      targetId: "",
      from: "2026-10-11T12:00",
      to: "2026-10-11T11:00",
    });
    expect(r.filters.actorId).toBe("u1");
    expect(r.error).toMatch(/before/);
  });
});

describe("MFA secret display", () => {
  it("groups the base32 secret for manual entry", () => {
    expect(groupSecret("JBSWY3DPEHPK3PXP")).toBe("JBSW Y3DP EHPK 3PXP");
  });
});

describe("permissions", () => {
  it("checks global and scoped grants", () => {
    const me = {
      ...makeMe({ permissions: ["monitoring.view"] }),
      scopedPermissions: [
        { scopeType: "node" as const, scopeId: "n1", permissions: ["nodes.manage" as const] },
      ],
    };
    expect(hasGlobal(me, "monitoring.view")).toBe(true);
    expect(can(me, "nodes.manage")).toBe(false);
    expect(can(me, "nodes.manage", { type: "node", id: "n1" })).toBe(true);
    expect(can(me, "nodes.manage", { type: "node", id: "n2" })).toBe(false);
    expect(canAny(me, "nodes.manage")).toBe(true);
    expect(isOwner(me)).toBe(false);
  });

  it("disables nav sections by phase or permission", () => {
    const me = makeMe({ permissions: ["monitoring.view"] });
    const by = (label: string) =>
      navAvailability(
        NAV_ITEMS.find((i) => i.label === label)!,
        me,
      );
    expect(NAV_ITEMS).toHaveLength(15);
    expect(by("Overview").kind).toBe("available");
    expect(by("Game Servers")).toEqual({ kind: "phase", reason: "Available in Phase 3" });
    expect(by("Backups")).toEqual({ kind: "phase", reason: "Available in Phase 6" });
    expect(by("Audit Logs").kind).toBe("forbidden");
    expect(by("Settings").kind).toBe("available");
  });

  it("explains which role permissions apply at a narrower scope", () => {
    const admin = { permissions: [...BUILTIN_ROLES.admin.permissions] };
    const atNode = applicablePermissions(admin, "node");
    expect(atNode.applies).toBeLessThan(atNode.total);
    expect(applicablePermissions(admin, "global")).toEqual({ applies: atNode.total, total: atNode.total });
  });
});
