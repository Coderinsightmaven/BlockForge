# Review: Control plane Phase 4a (backups, schedules, API keys)

* Author: Claude (backend agent) · Reviewer: Codex gpt-5.6-terra (high, two passes) · Date: 2026-10-12 · Scope: eea6c13, 9241c35, 8798386

| # | Sev | Finding | Resolution |
|---|-----|---------|------------|
| B1 | **Blocker** | Rotation deletes the oldest good backup before the new one exists (limit 1 + failed backup = no backups) | backend agent — pending |
| H1 | High | Migration 0003 drops `scopes`/`revoked_at` → revoked or scoped legacy tokens could become active all-permission keys | pending |
| H2 | High | `runNow` needs only `schedules.manage` but runs as the last editor → privilege delegation | pending |
| H3 | High | Startup `recover()` fails runs that another replica is executing → duplicate execution | pending |
| H4 | High | S3 backups store only the key; restore/download/delete use the *current* storage settings (wrong bucket, possibly deleting an unrelated object) | pending |
| H5 | High | Lock check-then-delete race in rotation/deletion | pending |
| H6 | High | Failed S3 uploads leave local archives behind (uncounted) → node disk exhaustion | pending |
| H7 | High | Save-flush confirmation compares CP time with agent log timestamps (clock skew → stale match or timeout) | pending |
| H8 | High | Successful backup restores `running` without checking the workload (crash during backup hidden) | pending |
| H9 | High | Finalize errors leave `active_operation` set (stranded lock) | pending |
| M1 | Med | `save-on` best-effort; no durable retry when the node disconnects | pending |
| M2 | Med | Multipart upload orphaned on presign failure/crash (upload id only in memory) | pending |
| M3 | Med | Scheduler claims 20 per tick; bursts beyond the catch-up window silently lose runs | pending |
| M4 | Med | Job waiting polls Postgres every 100 ms for hours; blocks shutdown | pending |
| M5 | Med | Schedule updates/deletes during a run: version skew, stuck `runningRunId` | pending |
| M6 | Med | Unbounded schedules per server and failed backups; unpaginated backup list | pending |
| M7 | Med | AWS SDK checksum defaults vs agent raw part PUTs (strict S3 endpoints) | pending |
| L1 | Low | API-key rate limit per process; invalid keys unthrottled | pending |
| L2 | Low | Console backfill size decided by the first request; system lines suppress backfill | pending |
| L3 | Low | Create-only users can create locked backups they cannot unlock | pending |
