# Review: Node agent backups (Phase 4a)

* Author: Claude (infrastructure agent) · Reviewer: Codex gpt-6-luna (high) · Date: 2026-10-12 · Scope: c04e042

| # | Sev | Finding | Resolution |
|---|-----|---------|------------|
| 1 | Major | Symlink swapped in after the walk's type check is followed by `OpenRegular` → `.blockforge/` (or other excluded) content archived under another name | Fixed: `fsops.WalkTree` (dirs opened relative to their parent, no-follow, dev/ino match + /proc/self/fd check); race test of ~3 500 swaps over 40 backups never leaked (pre-fix leaked on the 2nd); also applied to fs.copy/fs.compress |
| 2 | Major | `defer f.Close()` inside the walk keeps every file open → fd exhaustion, silently skipped files, incomplete backup reported as success | Fixed: explicit close per file (fd exhaustion did not reproduce — the defer was per callback), open/read errors fail the backup, vanished files logged, entry cap 2 000 000, depth cap 512 |
| 3 | Major | `maxBytes` bounds only compressed output → sparse/compressible files cost unbounded read I/O and CPU | Fixed: `backupMaxUncompressedBytes` (256 GiB, logical size) checked up front and while streaming; 64 GiB sparse file refused |
| 4 | Major | Truncate restore deletes existing data before extraction; a mid-extraction failure loses the old data | Fixed: staged extraction + journalled swap (`data.restore-*` → `data`, old kept until done), crash recovery on start (`RecoverRestores`), staged merge restores with collision check, disk check before writing |
| 5 | Major | `workload.ensure` ignores active install/restore claims | Fixed: ensure returns retryable BUSY during install/restore/backup claims; unit + real-Docker tests |
| 6 | Major | `**`-heavy ignore/denylist patterns cause combinatorial matching (Go + TS matcher) | Fixed in TS and Go (memoised single pass, >64 segments or >8 `**` never match, no depth cap; all 46 shared fixture cases pass; pathological case 0.01 s vs >30 s before) |

All 6 fixed (2026-10-12). Agent gates: Windows 110 tests, Linux -race 120, integration 132 (Paper backup → S3 parts → staged truncate restore), compose 1; orchestrator re-ran Windows vet + test.
