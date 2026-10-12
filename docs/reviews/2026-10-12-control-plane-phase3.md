# Review: Control plane Phase 3

* Author: Claude (backend agent) · Reviewer: Codex gpt-5.6-terra (high) · Date: 2026-10-12 · Scope: 88485b0 (+ 4c65336 migration)

| # | Sev | Finding | Resolution |
|---|-----|---------|------------|
| 1 | High | `/servers` list includes servers where the subuser lacks `servers.view` (full DTO leak) | Fixed: subuser listing requires servers.view + effective-permission backstop; regression test |
| 2 | High | Egg variable authorization uses `servers.admin` held anywhere, not on the target node/network | Fixed: non-editable variables need servers.admin on the chosen node/network; auto placement restricted accordingly |
| 3 | High | Install output (job log, console buffer, `console:` topic) can print secret egg variables (`echo "$DATABASE_PASSWORD"`) | Fixed: non-viewable variable values (+ base64) masked before console buffer, topic, job logs, install tail; fail-closed when masks unavailable |
| 4 | High | Decompress ignores archive entry paths → denied files (e.g. `forwarding.secret`) planted via extraction; compress output unchecked | Fixed: denylist + secret patterns sent to fs.extract/compress; control plane picks and checks compress output path |
| 5 | Med | Browser transfer URLs don't recheck access/suspension at consumption | Fixed: transfer consumption re-checks permissions, suspension and denylist |
| 6 | Med | Failed/cancelled provisioning converts the hold into a permanent reservation and keeps the allocation (capacity/port exhaustion) | Fixed: failed/cancelled first provision releases allocation + hold; reinstall re-acquires under node lock; owners may delete never-installed servers |
| 7 | Med | `/build` changes reservations without node lock or aggregate capacity check | Fixed: /build under node lock with capacity re-check (409 CAPACITY_EXCEEDED); audited overrideCapacity needs nodes.manage |
| 8 | Med | Catalogue fetch DNS not pinned to validated addresses (rebinding) | Fixed: pinned GET transport, per-hop DNS validation |
| 9 | Low | Username suffixing can exceed 32 chars after many collisions (SQL + TS) | Fixed in TS (base truncated by suffix length); dev DB unaffected (one 5-char username), no SQL migration needed |

All 9 resolved (2026-10-12), plus: Grok web #1 server side (idempotency hash includes the normalised query), template denylist + secret patterns forwarded to the agent on every fs.* call for non-admins (symlink-alias protection), `utime` SFTP activity. Gates re-run by orchestrator: typecheck, lint, 26 files / 252 tests.
