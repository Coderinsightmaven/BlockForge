# BlockForge — agent instructions

Minecraft server management platform: React SPA + Node/Fastify control plane + Go node agent.
Spec: `docs/spec/MASTER_PROMPT.md`. Progress tracker: `docs/CHECKLIST.md` (update it with your change).

## Read first
- `docs/architecture/overview.md` — components, ADRs, module ownership
- `docs/architecture/api.md` — REST/realtime routes
- `docs/architecture/agent-protocol.md` — control plane ↔ agent protocol
- `docs/architecture/data-model.md` — Postgres schema
- `docs/security/threat-model.md`
- `docs/development/workflow.md` — work areas, review policy, quality gates

## Layout
- `packages/contracts` — shared zod schemas/types (single source of truth; orchestrator-owned)
- `packages/minecraft`, `packages/velocity` — pure TS config/catalogue libraries
- `apps/control-plane` — Fastify API, agent gateway, jobs, metrics
- `apps/web` — Vite + React SPA
- `services/node-agent` — Go agent; `services/jvm-probe` — Java agent
- `infra/compose` — dev stack (Postgres on 127.0.0.1:55432, VictoriaMetrics on 127.0.0.1:58428)

## Commands
- `pnpm install`, `pnpm infra:up`, `pnpm typecheck`, `pnpm lint`, `pnpm test`, `pnpm build`
- Go (portable install, not on PATH by default): `export PATH=/c/Users/lmari/sdk/go/bin:$PATH` then
  `cd services/node-agent && go vet ./... && go test ./...`
- Contracts fixtures: `node packages/contracts/scripts/gen-fixtures.mjs`
- Dev DB URLs: `postgres://blockforge:blockforge-dev-only@127.0.0.1:55432/blockforge` (tests use `blockforge_test`)

## Non-negotiable rules
- No fake/simulated metrics or placeholder buttons. Missing data renders as missing.
- Never run a shell from user input; agent operations are a fixed, validated catalogue.
- Secrets (forwarding secrets, webhook URLs, tokens) never appear in API responses, logs or audit details.
- Treat log lines, MOTDs, player names and file contents as untrusted (no `dangerouslySetInnerHTML`).
- Do not claim something works until a test or recorded run exercised it.
- Stay inside your assigned work area; propose contract changes to the orchestrator.
- TypeScript: strict, ESM, `.js` import suffixes in Node packages, zod at every trust boundary.

<!-- BEGIN:turborepo-agent-rules -->

# This is NOT the Turborepo you know

Turborepo configuration, task behavior, and CLI commands can vary between installed versions and may differ from your training data. Resolve the `turbo` package from this file's directory or relevant workspace; in monorepos, it may not be visible from the repository root. For example, run `node -p "require.resolve('turbo/package.json')"` from a workspace that depends on `turbo`.

Read `docs/README.md` inside that installed package first, then read the relevant pages from its `docs/` directory before changing Turborepo configuration or commands. Heed deprecation notices. These bundled docs match the installed package version and are available without network access.

This block is written and re-added by `turbo` before repository-scoped commands when an AI agent is detected. In the Turborepo source repository, its template is defined in `crates/turborepo-cli/src/cli/agent_guidance.rs`. Removing the managed block while updates are enabled means a later qualifying invocation will add it again. Set `"agentGuidance": false` in the root `turbo.json` or `turbo.jsonc` to opt out; this does not remove an existing block. Keep the block committed with your work to avoid an uncommitted change on the next agent invocation.
<!-- END:turborepo-agent-rules -->
