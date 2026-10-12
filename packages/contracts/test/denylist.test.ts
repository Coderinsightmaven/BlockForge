import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { compileDenylist, SFTP_USERNAME_PATTERN } from "../src/index.js";

const fixture = JSON.parse(readFileSync(join(import.meta.dirname, "..", "fixtures", "denylist.json"), "utf8")) as {
  sets: { patterns: string[]; cases: Record<string, boolean> }[];
};

describe("fileDenylist (shared fixture with the Go agent)", () => {
  fixture.sets.forEach((set, i) => {
    it.each(Object.entries(set.cases))(`set ${i}: %j → %s`, (path, expected) => {
      expect(compileDenylist(set.patterns).denied(path)).toBe(expected);
    });
  });
  it("empty list denies nothing", () => {
    expect(compileDenylist([]).denied("anything")).toBe(false);
  });
});

describe("SFTP username", () => {
  it("matches <username>.<shortId>", () => {
    expect(SFTP_USERNAME_PATTERN.test("owner.e2f2e77b")).toBe(true);
    expect(SFTP_USERNAME_PATTERN.test("Owner.e2f2e77b")).toBe(false);
    expect(SFTP_USERNAME_PATTERN.test("owner.e2f2e77")).toBe(false);
    expect(SFTP_USERNAME_PATTERN.test("ow.e2f2e77b")).toBe(false);
  });
});
