# Review: Control plane (Phase 1–2)

* Author: Claude (backend agent) · Reviewer: Grok 4.7 (high) · Date: 2026-10-12 · Scope: `apps/control-plane/**`

| # | Sev | Finding | Resolution |
|---|-----|---------|------------|
| 1 | High | Self-service MFA disable keeps a pending pre-MFA session alive → it becomes fully authenticated | Fixed: strict session.mfaVerified gate; MFA disable revokes pending sessions |
| 2 | High | TOTP acceptance is check-then-act (concurrent/out-of-order reuse of a code) | Fixed: time step consumed via conditional UPDATE (concurrent/out-of-order reuse rejected) |
| 3 | High | Lockout counter read-modify-write; limiter keyed on raw email casing; locked vs unknown accounts distinguishable | Fixed: atomic counter, NFKC/lowercase limiter key, identical 429 for locked vs unknown accounts |
| 4 | High | `node.updated` on `nodes` topic gated by monitoring.view instead of nodes.view (moderators receive node records) | Fixed: `nodes` topic node.updated/node.metrics gated by nodes.view (mutation-checked test) |
| 5 | High | Agent frame queue bounded by count not bytes (≈16 GB per session, pending nodes may connect) | Fixed: byte-bounded queue with socket backpressure then shedding; tighter limits for pending nodes |
| 6 | Med | Login racing a password change can create a session the revocation missed | Fixed: session created in a tx that re-locks the user and re-checks hash/status/lock |
| 7 | Med | Rotation: pending-key wait registered after the agent already has the result | Fixed: RotationCoordinator.begin() before sending; queued frames drained before failing pending commands |
| 8 | Med | Node status checked outside the jti transaction (revocation race) | Fixed: node status + credential re-checked FOR SHARE inside the jti tx; attach refuses revoked/disabled |
| 9 | Med | Workload-ownership cache never invalidated; negative entries can be planted | Fixed: positive-only LRU cache with invalidate() |
| 10 | Med | No retention for jobs/job_logs/notification_deliveries; latest/console maps never pruned | Fixed: retention module (finished jobs+logs 30 d, deliveries 30 d) + cache pruning |
| 11 | Med | infra_admin/network_admin spread users.view + audit.view | Fixed in contracts (5f857d4) + test |
| 12 | Med | Open incidents loaded unbounded + N+1 scope checks | Fixed: scoped in SQL (`alerts/scope.ts`) |
| 13 | Med | Agent error bodies persisted unbounded/unredacted | Fixed: contract bounds + `sanitizeAgentError` (redactDeep, 1 KiB message / 4 KiB details) |
| 14 | Low | `global.*` metrics ignore network/server-scoped grants (under-grant) | Fixed: global.players honours server/network grants; node series stay node-grant only (documented) |
| 15 | Low | SSRF guard misses RFC 8215 `64:ff9b:1::/48` | Fixed: 64:ff9b:1::/48 blocked + test |
| 16 | Low | Global alert rules visible to scoped viewers; orphaned incidents authorised as global | Fixed: rules visible at their scope only; node deletion resolves its incidents |
| 17 | Low | Setup token in the log message string | Documented in control-plane README (trade-off accepted) |

All 17 findings resolved (2026-10-12); new `test/integration/review-fixes.int.test.ts`. Control-plane gates re-run by orchestrator: typecheck, lint, 20 files / 199 tests passing.
