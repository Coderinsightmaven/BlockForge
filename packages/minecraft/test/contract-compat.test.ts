import type { ArtifactPlan, SoftwareVersion } from "@blockforge/contracts";
import { ArtifactPlan as ArtifactPlanSchema } from "@blockforge/contracts";
import { describe, expect, it } from "vitest";
import type { CatalogVersion, ResolvedArtifact } from "../src/catalog/types.js";

// Compile-time guarantees: the library's types stay assignable to the shared contract DTOs.
type Assert<T extends true> = T;
type _ArtifactCompat = Assert<ResolvedArtifact extends ArtifactPlan ? true : false>;
type _VersionCompat = Assert<CatalogVersion extends SoftwareVersion ? true : false>;

describe("contract compatibility", () => {
  it("a resolved artifact parses with the ArtifactPlan schema", () => {
    const artifact: ResolvedArtifact = {
      software: "paper",
      version: "1.21.8",
      build: "60",
      channel: "stable",
      releasedAt: null,
      downloads: [
        {
          role: "server",
          url: "https://fill-data.papermc.io/v1/objects/x/paper.jar",
          destPath: "server.jar",
          checksum: { algorithm: "sha256", value: "a".repeat(64) },
          agentChecksum: { algorithm: "sha256", value: "a".repeat(64) },
          sizeBytes: 1,
          provenance: "PaperMC Fill v3",
        },
      ],
      java: { major: 21, source: "upstream", notes: [] },
      install: { kind: "none" },
      launch: { kind: "jar", jar: "server.jar", programArgs: ["nogui"] },
      requiresNetworkAtFirstStart: true,
      recommendedJvmFlags: null,
      provenance: "PaperMC Fill v3",
      notes: [],
    };
    expect(ArtifactPlanSchema.safeParse(artifact).success).toBe(true);
  });
});
