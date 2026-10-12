# Review: Node agent Phase 3 (SFTP, install containers, cache, fs ops)

* Author: Claude (infrastructure agent) · Reviewer: Codex gpt-6-luna (high) · Date: 2026-10-12 · Scope: 9d3a530

| # | Sev | Finding | Resolution |
|---|-----|---------|------------|
| 1 | High | SFTP denylist checked on the requested path while operations follow symlinks → `public.properties -> server.properties` bypass (same class of issue exists in the control-plane file manager) | Fixed in agent: shared matcher (`internal/denylist`, passes the contracts fixture), refusal on requested path / every traversed symlink / resolved path / tree entries, Linux post-open re-check via /proc/self/fd, SFTP opens without O_TRUNC until verified; fs.* `denylist` field enforced. Control-plane pass-through pending. |
| 2 | Med | Pre-auth handshake deadline extended by any byte (slowloris holds all 512 slots) | Fixed: absolute 30 s pre-auth deadline; idle timeout only after auth; test |
| 3 | Med | Auth attempts amplify into control-plane requests (no global concurrency/rate bound) | Fixed: ≤16 in flight, 20/s (burst 40) per node, 3 attempts per connection, blocked IPs never reach the control plane; test |
| 4 | Med | `fs.copy` has no byte limit (disk exhaustion) | Fixed: `copyMaxBytes` (10 GiB) bounded by free disk − 1 GiB, checked up front and while streaming, QUOTA_EXCEEDED with cleanup; tests |
| 5 | Low | Timestamp-only setstat not reported in activity | Fixed: `utime` action |
| 6 | Low | setstat can change the data root's timestamps | Fixed: every setstat counts as a mutation; refused on `/` |

SFTP stays disabled on the test node until #1–#3 are fixed and verified.

Agent gates (2026-10-12): Windows 90 tests, Linux -race 96, integration 105 (Paper + Vanilla + TeamSpeak eggs), compose 1 — all passing; orchestrator re-ran Windows `go vet` + `go test`.
