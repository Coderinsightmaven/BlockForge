import { describe, expect, it } from "vitest";
import { sanitizeAgentError } from "../../src/agents/gateway.js";

describe("agent error sanitisation (review #13)", () => {
  it("redacts secrets and caps message and details before they are stored", () => {
    const token = "bfe_0123456789abcdef_BwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwc";
    const e = sanitizeAgentError({
      code: "INTERNAL",
      message: `failed with ${token} ${"m".repeat(5000)}`,
      retryable: false,
      details: { password: "hunter2", nested: { url: "https://discord.com/api/webhooks/1/abc" }, blob: "d".repeat(10_000) },
    });
    expect(e.message.length).toBeLessThanOrEqual(1024);
    expect(e.message).not.toContain("BwcHBwcH");
    const json = JSON.stringify(e.details);
    expect(json).not.toContain("hunter2");
    expect(json).not.toContain("webhooks/1/abc");
    expect(json.length).toBeLessThanOrEqual(4200);
    expect(e.details).toMatchObject({ truncated: true });
    expect(sanitizeAgentError({ code: "NOT_FOUND", message: "x", retryable: true })).toEqual({ code: "NOT_FOUND", message: "x", retryable: true });
  });
});
