# Review: Node agent backups (Phase 4a)

* Author: Claude (infrastructure agent) · Reviewer: Codex gpt-6-luna (high) · Date: 2026-10-12 · Scope: c04e042

| # | Sev | Finding | Resolution |
|---|-----|---------|------------|
| 1 | Major | Symlink swapped in after the walk's type check is followed by `OpenRegular` → `.blockforge/` (or other excluded) content archived under another name | infrastructure agent — pending |
| 2 | Major | `defer f.Close()` inside the walk keeps every file open → fd exhaustion, silently skipped files, incomplete backup reported as success | pending |
| 3 | Major | `maxBytes` bounds only compressed output → sparse/compressible files cost unbounded read I/O and CPU | pending |
| 4 | Major | Truncate restore deletes existing data before extraction; a mid-extraction failure loses the old data | pending (staging + swap) |
| 5 | Major | `workload.ensure` ignores active install/restore claims | pending |
| 6 | Major | `**`-heavy ignore/denylist patterns cause combinatorial matching (Go + TS matcher) | TS fixed (memoised, limits, shared fixture cases); Go pending |
