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
