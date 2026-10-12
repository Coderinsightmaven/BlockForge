# Review: Go node agent

* Author: Claude (infrastructure agent) · Reviewer: Codex gpt-6-luna (high) · Date: 2026-10-12
* Scope: `services/node-agent/**`, `services/jvm-probe/**`, agent container/compose/systemd packaging

| # | Sev | Finding | Resolution |
|---|-----|---------|------------|
| 1 | High | Existing `bf-*` bridge networks reused without checking the managed label — workloads could join a network another tool created | Fixed: networks carry managed + node labels; foreign `bf-*` networks → CONFLICT before any side effect; integration test `TestForeignBfNetworkRefused` |
| 2 | Med | Failed journal append can leave a partial line that swallows the next record (replay-protection gap after restart) | Fixed: rollback to last good size + fsync, fail-closed (retryable INTERNAL) until repaired; unit + executor tests |
| 3 | Med | Reversed/overflowing command timestamps can pass the lifetime check | Fixed: `CheckCommandWindow` (expired → reversed → future → lifetime), overflow-safe; golden fixture `cmd-reject-reversed-timestamps.json` + 15 signed cases; agent emits `CLOCK_SKEW` warning |
| 4 | Low | systemd `ProtectHome=yes` breaks data roots under `/home` | Fixed: default unchanged, drop-in `packaging/drop-ins/home-data-root.conf` (verified with systemd-analyze) |

Reviewer highlights (keep): signature verified over exact body bytes before parsing; `os.Root` sandbox with
bounded extraction; redirect re-validation and checksum-before-rename; label-filtered discovery with
unlabelled-collision rejection; full container hardening. `go vet` and `go test` passed for the reviewer.

All 4 findings fixed (2026-10-12). Agent gates: go vet clean; unit 54 (Windows) / 56 (Linux -race); integration 62 incl. real Paper — all passing.
