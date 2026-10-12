# Review: Control plane (Phase 1–2)

* Author: Claude (backend agent) · Reviewer: Grok 4.7 (high) · Date: 2026-10-12 · Scope: `apps/control-plane/**`

| # | Sev | Finding | Resolution |
|---|-----|---------|------------|
| 1 | High | Self-service MFA disable keeps a pending pre-MFA session alive → it becomes fully authenticated | backend agent — pending |
| 2 | High | TOTP acceptance is check-then-act (concurrent/out-of-order reuse of a code) | pending |
| 3 | High | Lockout counter read-modify-write; limiter keyed on raw email casing; locked vs unknown accounts distinguishable | pending |
| 4 | High | `node.updated` on `nodes` topic gated by monitoring.view instead of nodes.view (moderators receive node records) | pending |
| 5 | High | Agent frame queue bounded by count not bytes (≈16 GB per session, pending nodes may connect) | pending |
| 6 | Med | Login racing a password change can create a session the revocation missed | pending |
| 7 | Med | Rotation: pending-key wait registered after the agent already has the result | pending |
| 8 | Med | Node status checked outside the jti transaction (revocation race) | pending |
| 9 | Med | Workload-ownership cache never invalidated; negative entries can be planted | pending |
| 10 | Med | No retention for jobs/job_logs/notification_deliveries; latest/console maps never pruned | pending |
| 11 | Med | infra_admin/network_admin spread users.view + audit.view | Fixed in contracts (5f857d4) + test |
| 12 | Med | Open incidents loaded unbounded + N+1 scope checks | pending |
| 13 | Med | Agent error bodies persisted unbounded/unredacted | Contract bounds added (5f857d4); control plane must redact before storing — pending |
| 14 | Low | `global.*` metrics ignore network/server-scoped grants (under-grant) | pending |
| 15 | Low | SSRF guard misses RFC 8215 `64:ff9b:1::/48` | pending |
| 16 | Low | Global alert rules visible to scoped viewers; orphaned incidents authorised as global | pending |
| 17 | Low | Setup token in the log message string | pending (documented trade-off acceptable) |
