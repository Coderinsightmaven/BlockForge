/**
 * Contract-valid Phase 4b objects for tests only (every builder parses with the contract schema).
 */
import {
  ExtensionHistoryEntry,
  ExtensionList,
  ExtensionMetadataView,
  ExtensionUpdatesResponse,
  InstalledExtension,
  ModrinthInstallPlan,
  ModrinthPlannedFile,
  ModrinthProjectResponse,
  ModrinthSearchResult,
  PlayersOverview,
} from "@blockforge/contracts";
import type { z } from "zod";
import { SERVER_ID, USER_ID } from "./fixtures";

type In<T extends z.ZodType> = z.input<T>;
export const EXT_ID = "e0000000-0000-4000-8000-000000000001";
export const EXT_ID_2 = "e0000000-0000-4000-8000-000000000002";
export const HISTORY_ID = "f0000000-0000-4000-8000-000000000001";
export const UPLOAD_ID = "c1000000-0000-4000-8000-000000000001";
const SHA512 = "a".repeat(128);
const SHA1 = "b".repeat(40);

const meta = (over: Record<string, unknown> = {}) =>
  ExtensionMetadataView.parse({
    format: "paper",
    id: "essentials",
    name: "EssentialsX",
    version: "2.21.0",
    description: "Essential commands",
    authors: ["md_5"],
    environment: null,
    dependencies: [],
    minecraftVersion: "1.21",
    loaderVersion: null,
    foliaSupported: null,
    entrypoint: "com.earth2me.essentials.Essentials",
    libraries: [],
    bundledJars: [],
    license: null,
    homepage: null,
    warnings: [],
    ...over,
  });

export function makeExtension(over: Partial<In<typeof InstalledExtension>> = {}): InstalledExtension {
  return InstalledExtension.parse({
    id: EXT_ID,
    serverId: SERVER_ID,
    kind: "plugin",
    path: "plugins/EssentialsX-2.21.0.jar",
    filename: "EssentialsX-2.21.0.jar",
    enabled: true,
    sizeBytes: 1_200_000,
    sha512: SHA512,
    mtime: 1_760_000_000_000,
    source: "modrinth",
    metadata: [meta()],
    compatibility: { loadable: true, metadataIndex: 0, problems: [] },
    modrinth: {
      projectId: "hXiIvTyT",
      slug: "essentialsx",
      title: "EssentialsX",
      versionId: "Ver00001",
      versionNumber: "2.21.0",
      versionType: "release",
      iconUrl: "https://cdn.modrinth.com/data/hXiIvTyT/icon.png",
      pageUrl: "https://modrinth.com/project/essentialsx",
    },
    installedAt: 1_760_000_000_000,
    installedBy: { id: USER_ID, name: "owner" },
    firstSeenAt: 1_760_000_000_000,
    ...over,
  });
}

export { meta as makeMetadata };

export function makeExtensionList(over: Partial<In<typeof ExtensionList>> = {}): ExtensionList {
  return ExtensionList.parse({
    installDir: "plugins",
    kind: "plugin",
    items: [makeExtension()],
    skipped: [],
    scan: { status: "completed", scannedAt: 1_760_000_100_000, jobId: null, error: null },
    truncated: false,
    uploads: { allowed: true, requireMetadata: true },
    ...over,
  });
}

export function makeSearchResult(over: Partial<In<typeof ModrinthSearchResult>> = {}): ModrinthSearchResult {
  return ModrinthSearchResult.parse({
    hits: [
      {
        projectId: "gvQqBUqZ",
        slug: "lithium",
        title: "Lithium",
        description: "<b>No-compromise</b> game logic optimization",
        author: "jellysquid3",
        loaders: ["fabric"],
        categories: ["optimization"],
        projectTypes: ["mod"],
        downloads: 12_000_000,
        follows: 1000,
        iconUrl: null,
        license: "LGPL-3.0",
        clientSide: "optional",
        serverSide: "optional",
        clientOnly: false,
        loaderMatch: "match",
        dateModified: 1_760_000_000_000,
        latestVersionId: "Ver00002",
        installed: false,
      },
      {
        projectId: "QuiltOne",
        slug: "quilty",
        title: "Quilty",
        description: "A Quilt mod",
        author: "someone",
        loaders: ["quilt"],
        categories: [],
        projectTypes: ["mod"],
        downloads: 10,
        follows: 1,
        iconUrl: null,
        license: "MIT",
        clientSide: "unknown",
        serverSide: "required",
        clientOnly: false,
        loaderMatch: "warning",
        dateModified: null,
        latestVersionId: null,
        installed: true,
      },
    ],
    offset: 0,
    limit: 20,
    totalHits: 2,
    filteredOut: 1,
    ...over,
  });
}

export function makeProject(): ModrinthProjectResponse {
  return ModrinthProjectResponse.parse({
    project: {
      projectId: "gvQqBUqZ",
      slug: "lithium",
      title: "Lithium",
      description: "Line one\n<script>alert(1)</script>",
      projectType: "mod",
      loaders: ["fabric"],
      categories: ["optimization"],
      gameVersions: ["1.21.4"],
      clientSide: "optional",
      serverSide: "optional",
      clientOnly: false,
      status: "approved",
      license: { id: "LGPL-3.0", name: "LGPL 3", url: null },
      downloads: 12_000_000,
      followers: 1000,
      iconUrl: null,
      sourceUrl: "https://github.com/CaffeineMC/lithium",
      issuesUrl: null,
      wikiUrl: null,
      pageUrl: "https://modrinth.com/project/lithium",
      published: 1,
      updated: 2,
      compatible: true,
    },
    versions: [
      {
        versionId: "Ver00002",
        projectId: "gvQqBUqZ",
        name: "Lithium 0.15",
        versionNumber: "0.15.0",
        versionType: "release",
        status: "listed",
        datePublished: 1_760_000_000_000,
        loaders: ["fabric"],
        gameVersions: ["1.21.4"],
        loaderMatch: "match",
        gameVersionMatch: true,
        dependencies: [],
        primaryFile: { filename: "lithium-0.15.0.jar", sizeBytes: 700_000, sha1: SHA1, sha512: SHA512 },
      },
    ],
    installed: [],
  });
}

const plannedFile = (over: Record<string, unknown> = {}) =>
  ModrinthPlannedFile.parse({
    action: "install",
    reason: "requested",
    requiredBy: [],
    projectId: "gvQqBUqZ",
    projectSlug: "lithium",
    projectTitle: "Lithium",
    versionId: "Ver00002",
    versionNumber: "0.15.0",
    versionType: "release",
    loaders: ["fabric"],
    filename: "lithium-0.15.0.jar",
    url: "https://cdn.modrinth.com/data/gvQqBUqZ/versions/Ver00002/lithium-0.15.0.jar",
    sizeBytes: 700_000,
    sha1: SHA1,
    sha512: SHA512,
    destPath: "mods/lithium-0.15.0.jar",
    replaces: [],
    ...over,
  });
export { plannedFile as makePlannedFile };

export function makePlan(over: Partial<In<typeof ModrinthInstallPlan>> = {}): ModrinthInstallPlan {
  return ModrinthInstallPlan.parse({
    software: "fabric",
    minecraftVersion: "1.21.4",
    installDir: "mods",
    root: {
      projectId: "gvQqBUqZ",
      slug: "lithium",
      title: "Lithium",
      versionId: "Ver00002",
      versionNumber: "0.15.0",
    },
    files: [plannedFile()],
    alreadyInstalled: [],
    optionalDependencies: [],
    warnings: [],
    installable: true,
    restartRequired: true,
    ...over,
  });
}

export function makeUpdates(): ExtensionUpdatesResponse {
  return ExtensionUpdatesResponse.parse({
    checkedAt: 1_760_000_200_000,
    items: [
      {
        extensionId: EXT_ID,
        path: "plugins/EssentialsX-2.21.0.jar",
        current: {
          projectId: "hXiIvTyT",
          versionId: "Ver00001",
          versionNumber: "2.21.0",
          datePublished: null,
        },
        latest: {
          projectId: "hXiIvTyT",
          versionId: "Ver00003",
          versionNumber: "2.22.0",
          versionType: "release",
          datePublished: null,
        },
        updateAvailable: true,
        file: plannedFile({
          action: "replace",
          projectId: "hXiIvTyT",
          versionId: "Ver00003",
          versionNumber: "2.22.0",
          filename: "EssentialsX-2.22.0.jar",
          url: "https://cdn.modrinth.com/data/hXiIvTyT/versions/Ver00003/EssentialsX-2.22.0.jar",
          destPath: "plugins/EssentialsX-2.22.0.jar",
          replaces: ["plugins/EssentialsX-2.21.0.jar"],
        }),
        problem: null,
      },
    ],
  });
}

export function makeHistoryEntry(
  over: Partial<In<typeof ExtensionHistoryEntry>> = {},
): ExtensionHistoryEntry {
  return ExtensionHistoryEntry.parse({
    id: HISTORY_ID,
    serverId: SERVER_ID,
    action: "update",
    extensionId: EXT_ID,
    extensionName: "EssentialsX",
    path: "plugins/EssentialsX-2.22.0.jar",
    from: {
      source: "modrinth",
      path: "plugins/EssentialsX-2.21.0.jar",
      projectId: "hXiIvTyT",
      versionId: "Ver00001",
      versionNumber: "2.21.0",
      sha512: SHA512,
      sizeBytes: 1,
    },
    to: {
      source: "modrinth",
      path: "plugins/EssentialsX-2.22.0.jar",
      projectId: "hXiIvTyT",
      versionId: "Ver00003",
      versionNumber: "2.22.0",
      sha512: SHA512,
      sizeBytes: 1,
    },
    actor: { type: "user", id: USER_ID, name: "owner" },
    at: 1_760_000_300_000,
    jobId: null,
    status: "succeeded",
    error: null,
    rollback: { available: true, reason: null },
    ...over,
  });
}

export function makeOverview(over: Partial<In<typeof PlayersOverview>> = {}): PlayersOverview {
  return PlayersOverview.parse({
    online: {
      count: 1,
      max: 20,
      players: [{ name: "Alex", uuid: "11111111-2222-4333-8444-555555555555" }],
      skipped: 0,
      source: "list",
      at: 1_760_000_000_000,
    },
    onlineMode: true,
    whitelist: {
      enabled: true,
      enforced: false,
      entries: [{ uuid: "11111111-2222-4333-8444-666666666666", name: "Steve" }],
    },
    ops: [
      { uuid: "11111111-2222-4333-8444-777777777777", name: "Admin", level: 4, bypassesPlayerLimit: false },
    ],
    bannedPlayers: [
      {
        uuid: "11111111-2222-4333-8444-888888888888",
        name: "Griefer",
        createdAt: 1,
        source: "<b>Server</b>",
        expiresAt: null,
        reason: "<img src=x onerror=alert(1)>",
        active: true,
      },
    ],
    bannedIps: [],
    truncated: [],
    listErrors: [],
    availableActions: [
      "kick",
      "ban",
      "pardon",
      "ban-ip",
      "pardon-ip",
      "op",
      "deop",
      "whitelist-add",
      "whitelist-remove",
      "whitelist-set",
      "whitelist-reload",
    ],
    ...over,
  });
}
