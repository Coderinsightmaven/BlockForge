-- Phase 4b live-run follow-up: `installed_extensions.source` is provenance. Scans used to label files found on
-- disk `modrinth` once a SHA-512 lookup identified them; such files are `unknown` (the identification stays in
-- `modrinth`). BlockForge installs, updates, rollbacks and uploads always set `installed_at`, so a `modrinth`
-- row without it was labelled by a scan. History snapshots (extension_history.from/to) are left as recorded.
UPDATE "installed_extensions" SET "source" = 'unknown' WHERE "source" = 'modrinth' AND "installed_at" IS NULL;
