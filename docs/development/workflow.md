# Development Workflow

## Orchestration
The orchestrator (lead agent) owns `packages/contracts`, `docs/architecture`, and
`docs/CHECKLIST.md`. Specialized agents work in **separate work areas** and must not edit
files outside their area without coordinating through the orchestrator:

| Work area | Paths |
|-----------|-------|
| Backend / Monitoring / Security | `apps/control-plane/**` |
| Frontend | `apps/web/**` |
| Infrastructure | `services/node-agent/**`, `services/jvm-probe/**`, `infra/**` |
| Minecraft | `packages/minecraft/**`, `packages/velocity/**` |
| Testing | `tests/**` |

Changes to `packages/contracts` are proposed to the orchestrator, applied once, and then
consumed by everyone (TS via workspace import; Go via mirrored structs + golden fixtures).

## Cross-agent review
* Code written by Claude is reviewed by a different model family (Codex or Grok) via
  T3 delegated review tasks; code written by Codex/Grok is reviewed by Claude.
* Reviews cover correctness, security, performance, maintainability, error handling, tests.
* Critical/high findings are fixed before the work area is considered done; findings and
  resolutions are recorded in `docs/reviews/<date>-<area>.md`.

## Quality gates (run before declaring anything done)
```
pnpm install
pnpm -r typecheck
pnpm -r lint
pnpm -r test
pnpm -r build
cd services/node-agent && go vet ./... && go test ./...
```
Type checking and the TypeScript emit of `build` use **`tsc-rs`**, a Rust port of the TypeScript 7
compiler (root devDependency, pinned to an exact version; default checker count, not `--fast`, so the
diagnostics do not depend on the machine's core count). `typescript` ~6.0.3 stays installed for ESLint
(typescript-eslint), vitest, drizzle-kit and editors, so the editor and `pnpm typecheck` run different
compiler versions. If tsc-rs reports something TypeScript 6 does not (or crashes), check the package
with TypeScript 6 — `pnpm exec tsc -p tsconfig.json --noEmit`, or `pnpm exec tsc -p tsconfig.build.json`
for the emit — and record the difference; never silence a TS 7 diagnostic with `any` or `@ts-ignore`.
A fix must be valid for both compilers. Upgrades: `docs/OPEN_WORK.md` §5.3.

turbo runs tasks in strict env mode: a script only sees the environment variables that `turbo.json`
lists for its task. The `test` task lists the variables the tests read (`TEST_DATABASE_URL`,
`TEST_VICTORIA_METRICS_URL`, `TEST_S3_*`, `TEST_LOG_LEVEL`, `EGG_CORPUS_DIR`, `BLOCKFORGE_LIVE_TESTS` in
`env`, so they are part of the cache key; `NODE_EXTRA_CA_CERTS` in `passThroughEnv`). A test that reads a
new variable must add it there, or `pnpm test` silently uses the default (for `TEST_DATABASE_URL` the
shared `blockforge_test`, whose schema the control-plane global setup drops). Isolated run from a
worktree: `TEST_DATABASE_URL=postgres://…/blockforge_test_<name> NODE_EXTRA_CA_CERTS=<main
checkout>/infra/compose/.minio-certs/public.crt pnpm test` (or vitest directly in `apps/control-plane`).

Integration tests that need Postgres/VictoriaMetrics/Docker use `infra/compose/docker-compose.dev.yml`
(`pnpm infra:up`). Tests that need real Minecraft containers are tagged and run with
`pnpm test:integration`.

## Rules
* No placeholder buttons: a control either works end-to-end or is not rendered.
* No fake metrics, ever — missing data is shown as missing.
* Never claim a feature works until it has been exercised by a test or a recorded manual run.
* Update `docs/CHECKLIST.md` in the same change.
