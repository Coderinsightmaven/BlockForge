import { z } from "zod";

/**
 * Zod schemas for the Modrinth API v2 responses BlockForge uses (shapes verified live on
 * 2026-10-12, see test/fixtures/modrinth). Unknown keys are stripped; string enums that Modrinth
 * extends over time (`project_type`, `environment`, `status`, side support) stay plain strings and
 * are interpreted by the library, so a new upstream value never breaks parsing.
 */

/** Base62 ids (8 characters today). */
export const ModrinthId = z.string().regex(/^[A-Za-z0-9]{1,16}$/);
export const Sha1Hex = z.string().regex(/^[a-f0-9]{40}$/);
export const Sha512Hex = z.string().regex(/^[a-f0-9]{128}$/);

const Str = z.string().max(4096);
const LongText = z.string().max(65_536);
const StrList = z.array(z.string().max(256)).max(4096);

export const ModrinthSearchHitSchema = z.object({
  project_id: ModrinthId,
  project_type: Str,
  all_project_types: StrList.optional(),
  slug: Str.nullable(),
  author: Str,
  title: Str,
  description: LongText,
  categories: StrList,
  display_categories: StrList.optional(),
  versions: StrList,
  downloads: z.number().int().nonnegative(),
  follows: z.number().int().nonnegative(),
  icon_url: Str.nullable().optional(),
  date_created: Str,
  date_modified: Str,
  latest_version: Str.nullable().optional(),
  license: Str,
  client_side: Str,
  server_side: Str,
  environment: StrList.optional(),
});
export type ModrinthSearchHitRaw = z.infer<typeof ModrinthSearchHitSchema>;

export const ModrinthSearchResponseSchema = z.object({
  hits: z.array(ModrinthSearchHitSchema).max(100),
  offset: z.number().int().nonnegative(),
  limit: z.number().int().nonnegative(),
  total_hits: z.number().int().nonnegative(),
});

export const ModrinthLicenseSchema = z.object({ id: Str, name: Str, url: Str.nullable().optional() });

export const ModrinthProjectSchema = z.object({
  id: ModrinthId,
  slug: Str,
  project_type: Str,
  title: Str,
  description: LongText,
  categories: StrList,
  additional_categories: StrList.optional(),
  loaders: StrList,
  game_versions: StrList,
  versions: z.array(ModrinthId).max(65_536),
  client_side: Str,
  server_side: Str,
  environment: StrList.optional(),
  status: Str,
  license: ModrinthLicenseSchema.nullable().optional(),
  downloads: z.number().int().nonnegative(),
  followers: z.number().int().nonnegative(),
  icon_url: Str.nullable().optional(),
  source_url: Str.nullable().optional(),
  issues_url: Str.nullable().optional(),
  wiki_url: Str.nullable().optional(),
  discord_url: Str.nullable().optional(),
  published: Str,
  updated: Str,
  team: ModrinthId.optional(),
  organization: ModrinthId.nullable().optional(),
});
export type ModrinthProjectRaw = z.infer<typeof ModrinthProjectSchema>;

export const ModrinthFileSchema = z.object({
  hashes: z.object({ sha1: Sha1Hex, sha512: Sha512Hex.optional() }),
  url: Str,
  filename: z.string().max(512),
  primary: z.boolean(),
  size: z.number().int().nonnegative(),
  file_type: Str.nullable().optional(),
});
export type ModrinthFileRaw = z.infer<typeof ModrinthFileSchema>;

export const ModrinthDependencySchema = z.object({
  version_id: ModrinthId.nullable().optional(),
  project_id: ModrinthId.nullable().optional(),
  file_name: z.string().max(512).nullable().optional(),
  dependency_type: Str,
});
export type ModrinthDependencyRaw = z.infer<typeof ModrinthDependencySchema>;

export const ModrinthVersionSchema = z.object({
  id: ModrinthId,
  project_id: ModrinthId,
  author_id: ModrinthId.optional(),
  name: Str,
  version_number: Str,
  changelog: z.string().max(1_048_576).nullable().optional(),
  date_published: Str,
  downloads: z.number().int().nonnegative(),
  version_type: Str,
  status: Str.optional(),
  featured: z.boolean().optional(),
  loaders: StrList,
  game_versions: StrList,
  environment: Str.optional(),
  files: z.array(ModrinthFileSchema).max(64),
  dependencies: z.array(ModrinthDependencySchema).max(1024),
});
export type ModrinthVersionRaw = z.infer<typeof ModrinthVersionSchema>;

/** `/version_files` and `/version_files/update` answer `{ <hash>: Version }`; keys must be hashes (no `__proto__`). */
export const ModrinthHashMapSchema = z.record(z.union([Sha1Hex, Sha512Hex]), ModrinthVersionSchema);
