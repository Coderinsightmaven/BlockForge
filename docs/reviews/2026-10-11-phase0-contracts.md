# Review: Phase 0 architecture & contracts

* Author: Claude (orchestrator) · Reviewer: Codex (gpt-6-luna, high reasoning) · Date: 2026-10-11
* Scope: `docs/architecture/*`, `docs/security/threat-model.md`, `packages/contracts/**`

| # | Sev | Finding | Resolution |
|---|-----|---------|------------|
| 1 | High | Replay state (agent `jti` cache, agent command seen-set) not durable / not replica-shared | `agent_auth_jti` table; fsync'd agent command journal; idempotent command semantics documented (agent-protocol §3, §4) |
| 2 | High | Key rotation had no safe overlap/activation proof | Staged rotation with proof of possession, `pending` credential with TTL, promotion on first use, agent fallback (§3.1); fixtures added |
| 3 | High | `alerts` realtime topic gated by `monitoring.view` | Now `alerts.view` + per-incident scope filtering (api.md) |
| 4 | High | Moderator had `servers.console.send` (operator-equivalent) | Removed; permission documented as operator-equivalent; test added |
| 5 | High | `--insecure-allow-http` not restricted | Only loopback + `host.docker.internal` (`INSECURE_HTTP_ALLOWED_HOSTS`) |
| 6 | High | `CreateServerRequest` allowed kind/software mismatch | `superRefine` (+ heap < limit); `CreateServerBase` for partial forms; tests |
| 7 | High | `RelativePath` allowed data-root targets for destructive ops | `MutableRelativePath` for all mutations; agent enforces independently; fixture `cmd-reject-root-delete.json` |
| 8 | High | Image allowlist not represented | Schema validates reference shape only; agent allowlist matching rules specified (§6) |
| 9 | High | Only `fs.write` treated as sensitive | Field-level `COMMAND_REDACTIONS` + `redactCommandPayload()`; tests |
| 10 | Med | Lifecycle: no delete from stuck provisioning; no `→ unreachable` from long operations | Transitions + operation sources updated |
| 11 | Med | No request idempotency on job-creating routes | `Idempotency-Key` semantics + `idempotency_keys` table |
| 12 | Med | UUID arrays for ordered routing targets lacked FKs | `network_try_servers`, `forced_host_targets` join tables |
| 13 | Med | Host percentages unbounded | 0–100 for host metrics, agents clamp; workload CPU stays per-core |

All 13 findings accepted and fixed in commit "Contracts: address Codex Phase 0 review". Contract tests: 53 passing.
