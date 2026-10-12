# Review: Node agent Phase 3 (SFTP, install containers, cache, fs ops)

* Author: Claude (infrastructure agent) · Reviewer: Codex gpt-6-luna (high) · Date: 2026-10-12 · Scope: 9d3a530

| # | Sev | Finding | Resolution |
|---|-----|---------|------------|
| 1 | High | SFTP denylist checked on the requested path while operations follow symlinks → `public.properties -> server.properties` bypass (same class of issue exists in the control-plane file manager) | Contract: optional `denylist` on fs.* commands, enforced by the agent on requested + resolved paths (c.f. commit below); agent + control-plane fixes pending |
| 2 | Med | Pre-auth handshake deadline extended by any byte (slowloris holds all 512 slots) | pending |
| 3 | Med | Auth attempts amplify into control-plane requests (no global concurrency/rate bound) | pending |
| 4 | Med | `fs.copy` has no byte limit (disk exhaustion) | pending |
| 5 | Low | Timestamp-only setstat not reported in activity | Contract: `utime` action added; agent pending |
| 6 | Low | setstat can change the data root's timestamps | pending |

SFTP stays disabled on the test node until #1–#3 are fixed and verified.
