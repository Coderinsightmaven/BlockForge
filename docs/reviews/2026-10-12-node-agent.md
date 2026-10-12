# Review: Go node agent

* Author: Claude (infrastructure agent) · Reviewer: Codex gpt-6-luna (high) · Date: 2026-10-12
* Scope: `services/node-agent/**`, `services/jvm-probe/**`, agent container/compose/systemd packaging

| # | Sev | Finding | Resolution |
|---|-----|---------|------------|
| 1 | High | Existing `bf-*` bridge networks reused without checking the managed label — workloads could join a network another tool created | Sent to infrastructure agent — pending |
| 2 | Med | Failed journal append can leave a partial line that swallows the next record (replay-protection gap after restart) | pending |
| 3 | Med | Reversed/overflowing command timestamps can pass the lifetime check | pending |
| 4 | Low | systemd `ProtectHome=yes` breaks data roots under `/home` | pending |

Reviewer highlights (keep): signature verified over exact body bytes before parsing; `os.Root` sandbox with
bounded extraction; redirect re-validation and checksum-before-rename; label-filtered discovery with
unlabelled-collision rejection; full container hardening. `go vet` and `go test` passed for the reviewer.
