# Review: Control plane Phase 3

* Author: Claude (backend agent) · Reviewer: Codex gpt-5.6-terra (high) · Date: 2026-10-12 · Scope: 88485b0 (+ 4c65336 migration)

| # | Sev | Finding | Resolution |
|---|-----|---------|------------|
| 1 | High | `/servers` list includes servers where the subuser lacks `servers.view` (full DTO leak) | backend agent — pending |
| 2 | High | Egg variable authorization uses `servers.admin` held anywhere, not on the target node/network | pending |
| 3 | High | Install output (job log, console buffer, `console:` topic) can print secret egg variables (`echo "$DATABASE_PASSWORD"`) | pending |
| 4 | High | Decompress ignores archive entry paths → denied files (e.g. `forwarding.secret`) planted via extraction; compress output unchecked | pending (agent also enforces via fs.extract `denylist`) |
| 5 | Med | Browser transfer URLs don't recheck access/suspension at consumption | pending |
| 6 | Med | Failed/cancelled provisioning converts the hold into a permanent reservation and keeps the allocation (capacity/port exhaustion) | pending |
| 7 | Med | `/build` changes reservations without node lock or aggregate capacity check | pending |
| 8 | Med | Catalogue fetch DNS not pinned to validated addresses (rebinding) | pending |
| 9 | Low | Username suffixing can exceed 32 chars after many collisions (SQL + TS) | pending |
