# Review: Node agent `fs.hash` + `jar.readEntries` (Phase 4b)

* Author: Claude (infrastructure agent) · Reviewer: Codex gpt-6-luna (high) · Date: 2026-10-12 · Scope: 3125c66
* Verdict: no blocker/high; 2 medium, 1 low. Reviewer re-ran `go test ./internal/jarread/ ./internal/fsops/ ./internal/protocol/` (pass); its Linux race run could not start (WSL without bash) — the author's and orchestrator's `scripts/test-linux.sh -race` runs passed.

| # | Sev | Finding | Resolution |
|---|-----|---------|------------|
| 1 | Medium | Change detection compares only size + mtime (`fsops/scan.go:137`): a workload can rewrite a jar in place with the same size and restore the mtime, so hash and parsed entries may describe different contents without `IO_ERROR` (probe executed: same-size replacement with restored mtime → `OK`) | Open |
| 2 | Medium | No command-wide read budget for `jar.readEntries`: `maxJarBytes` applies per path, so 256 × 2 GiB with whole-file hashes = up to 512 GiB of reads in one command; `maxTotalBytes` only bounds returned content | Open — contract now has `maxReadBytes` (default 8 GiB, max 64 GiB; `BUDGET_EXCEEDED` past it, first jar always processed) |
| 3 | Low | Escaping symlinks report `NOT_REGULAR` instead of `PATH_FORBIDDEN` (`fsops/scan.go:37-46` only keeps denylist errors from `checkDeny`), unlike `fs.read` | Open |

Test gaps called out: same-size rewrite with restored mtime, command-wide read limit, escaping-symlink error mapping.
