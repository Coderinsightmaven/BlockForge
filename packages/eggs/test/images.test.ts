import { describe, expect, it } from "vitest";
import { DEFAULT_AGENT_IMAGE_ALLOWLIST, imageAllowed, parseEgg, parseImageRef } from "../src/index.js";
import { eggFixture } from "./helpers.js";

describe("agent image allowlist (mirrors the node agent defaults)", () => {
  it("lists the yolk/installer/steamcmd repositories community eggs use", () => {
    expect(DEFAULT_AGENT_IMAGE_ALLOWLIST).toEqual([
      "eclipse-temurin:*",
      "ghcr.io/pterodactyl/yolks:*",
      "ghcr.io/pterodactyl/installers:*",
      "ghcr.io/parkervcp/yolks:*",
      "ghcr.io/parkervcp/installers:*",
      "ghcr.io/parkervcp/steamcmd:*",
      "ghcr.io/pelican-eggs/yolks:*",
      "ghcr.io/pelican-eggs/installers:*",
      "ghcr.io/pelican-eggs/steamcmd:*",
    ]);
  });

  it.each([
    ["ghcr.io/pelican-eggs/yolks:java_21", true],
    ["ghcr.io/pelican-eggs/installers:debian", true],
    ["ghcr.io/pelican-eggs/steamcmd:debian", true],
    ["ghcr.io/parkervcp/steamcmd:proton", true],
    ["eclipse-temurin:21-jre", true],
    ["docker.io/library/eclipse-temurin:25-jre", true],
    ["ghcr.io/pelican-eggs/games:valheim", false],
    ["ghcr.io/parkervcp/games:valheim", false],
    ["ghcr.io/pelican-eggs/yolks@sha256:" + "a".repeat(64), false], // `repo:*` never matches digests
    ["ghcr.io/pelican-eggs/yolks", false], // no tag
    ["ghcr.io/pelican-eggs-evil/yolks:java_21", false],
  ])("%s → %s", (image, allowed) => {
    expect(imageAllowed(image)).toBe(allowed);
  });

  it("normalises Docker Hub short names", () => {
    expect(parseImageRef("eclipse-temurin:21-jre").repo).toBe("docker.io/library/eclipse-temurin");
  });

  it("Pelican eggs on pelican-eggs yolks need no allowlist change", () => {
    const egg = eggFixture("pelican-games-standalone-egg-tshock.json");
    egg["docker_images"] = { "Dotnet 9": "ghcr.io/pelican-eggs/yolks:dotnet_9" };
    ((egg["scripts"] as Record<string, Record<string, unknown>>)["installation"]!)["container"] = "ghcr.io/pelican-eggs/installers:debian";
    expect(parseEgg(egg, { category: "x" }).imagesNeedingAllowlist).toEqual([]);
  });

  it("eggs on ghcr.io/pelican-eggs/games still need an allowlist entry (import note)", () => {
    const egg = eggFixture("pelican-games-standalone-egg-tshock.json");
    egg["docker_images"] = { Valheim: "ghcr.io/pelican-eggs/games:valheim" };
    ((egg["scripts"] as Record<string, Record<string, unknown>>)["installation"]!)["container"] = "ghcr.io/pelican-eggs/installers:debian";
    const parsed = parseEgg(egg, { category: "x" });
    expect(parsed.imagesNeedingAllowlist).toEqual(["ghcr.io/pelican-eggs/games:valheim"]);
  });
});
