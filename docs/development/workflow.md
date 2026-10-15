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
pnpm typecheck:ts6
pnpm -r lint
pnpm -r test
pnpm -r build
pnpm emit-parity
cd services/node-agent && go vet ./... && go test ./...
```
Type checking and the TypeScript emit of `build` use **`tsc-rs`**, a Rust port of the TypeScript 7
compiler (root devDependency, pinned to an exact version; default checker count, not `--fast`, so the
diagnostics do not depend on the machine's core count). `typescript` ~6.0.3 stays installed for ESLint
(typescript-eslint), vitest, drizzle-kit and editors, so the editor and `pnpm typecheck` run different
compiler versions. Two TypeScript 6 gates in `scripts/ci/typescript6.mjs` (both run in CI) keep the
compilers in step (plus a selftest of the second):
* `pnpm typecheck:ts6` runs TypeScript 6 `--noEmit` over every project the `typecheck` scripts check.
* `pnpm emit-parity` (after `pnpm build`) emits every project the `build` scripts emit again with
  TypeScript 6, into a temporary directory, and compares it with `dist`: the file lists must match, `.js`
  must be byte-identical except for the allowlisted `import X, {} from "m"` → `import X from "m"` rewrite,
  `.d.ts` must parse without syntax errors and be identical, or equal after sorting the property
  signatures of type literals and the members of unions only (with the same comments), and source maps
  must be valid version-3 maps with the same `file`, `names` and resolved `sources` (`mappings` is not
  compared). Any other difference fails with a diff. If it is benign, add a precise, documented
  normalisation to the script (never a blanket ignore); otherwise switch the emit back to `tsc`.
* `node scripts/ci/typescript6.mjs selftest` checks those comparisons and the project discovery against
  fixed cases. Projects come from every workspace package's scripts (`pnpm ls -r`); a `tsc-rs` command
  the script cannot parse (another script name, flag or wrapper) fails the gate instead of being skipped.

If tsc-rs reports something TypeScript 6 does not (or crashes), check the package with TypeScript 6 —
`pnpm exec tsc -p tsconfig.json --noEmit`, or `pnpm exec tsc -p tsconfig.build.json` for the emit — and
record the difference; never silence a TS 7 diagnostic with `any` or `@ts-ignore`. A fix must be valid
for both compilers. Upgrades: `docs/OPEN_WORK.md` §5.3.

turbo caching: `typecheck` and `test` depend on the no-op `transit` task (`"dependsOn": ["^transit"]`),
so a change in a workspace dependency (for example `packages/contracts/src`) invalidates its dependents'
cached type checks and tests; `tsconfig.base.json` is a global dependency and the root
`eslint.config.js` an input of `lint`.

turbo runs tasks in strict env mode: a script only sees turbo's built-in pass-through variables (`PATH`,
`HOME`, `SHELL`, `PWD` and similar OS variables) and those `turbo.json` declares for its task. The tests'
variables are declared per package: `apps/control-plane/turbo.json` (`TEST_DATABASE_URL`,
`TEST_VICTORIA_METRICS_URL`, `TEST_S3_ENDPOINT`, `TEST_LOG_LEVEL` in `env`, which is part of the cache
key; `TEST_S3_ACCESS_KEY`, `TEST_S3_SECRET_KEY` and `NODE_EXTRA_CA_CERTS` in `passThroughEnv`),
`packages/eggs/turbo.json` (`EGG_CORPUS_DIR`) and `packages/minecraft/turbo.json`
(`BLOCKFORGE_LIVE_TESTS`; its tests also read `packages/velocity/test/fixtures`, an input of that task). A test that reads a new variable must be declared there, or `pnpm test`
silently uses the default — for `TEST_DATABASE_URL` that is the shared `blockforge_test`, whose schema the
control-plane global setup drops. Isolated run from a worktree (create the database first; the MinIO
certificate is generated in the main checkout only):
```
docker exec blockforge-dev-postgres-1 psql -U blockforge -d postgres -c 'CREATE DATABASE blockforge_test_<name> OWNER blockforge'
TEST_DATABASE_URL=postgres://blockforge:blockforge-dev-only@127.0.0.1:55432/blockforge_test_<name> \
  NODE_EXTRA_CA_CERTS=<main checkout>/infra/compose/.minio-certs/public.crt pnpm test
docker exec blockforge-dev-postgres-1 psql -U blockforge -d postgres -c 'DROP DATABASE blockforge_test_<name>'
```

Integration tests that need Postgres/VictoriaMetrics/Docker use `infra/compose/docker-compose.dev.yml`
(`pnpm infra:up`). Tests that need real Minecraft containers are tagged and run with
`pnpm test:integration`.

## Rules
* No placeholder buttons: a control either works end-to-end or is not rendered.
* No fake metrics, ever — missing data is shown as missing.
* Never claim a feature works until it has been exercised by a test or a recorded manual run.
* Update `docs/CHECKLIST.md` in the same change.
