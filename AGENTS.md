# AGENTS.md — conventions for humans and AI coding agents

EvolveSales is a pnpm monorepo. Read this before changing code. An approved implementation plan
tells you **what** to change; this file tells you **how** to do it in this repository.

## Layout

| Path                  | What lives there                                                       |
| --------------------- | ---------------------------------------------------------------------- |
| `apps/api`            | NestJS 12 HTTP API (`/api/v1/...`), modules per feature under `src/`   |
| `apps/orchestrator`   | NestJS 12 always-on worker (jobs, lifecycle, GitHub, agent containers) |
| `apps/web`            | React 19 + Vite + Mantine frontend, features under `src/features/`     |
| `packages/shared`     | Pure TypeScript shared by every app: types, zod schemas, business math |
| `packages/db`         | Prisma schema, migrations, seed (added in Phase 1)                     |
| `deploy/`, `.github/` | Infrastructure and pipelines — **AI agents must not modify these**     |

## Rules

- **ESM everywhere.** Relative imports in Node packages end in `.js` (`./health.controller.js`).
  `__dirname` does not exist; use `import.meta.dirname`.
- **TypeScript strict.** No `any`. Prefer types from `@evolvesales/shared` over redeclaring them.
- **Business rules belong in services** (api) or `packages/shared` (pure logic), never in controllers
  or React components.
- **Money** is calculated with `decimal.js` in `packages/shared`, never with JavaScript floats.
- **Tests:** Vitest everywhere. API unit tests sit next to the code as `*.spec.ts`; API HTTP tests in
  `apps/api/test/*.e2e-spec.ts`; web tests as `*.test.tsx`. Every behaviour change needs a test.
- **Database changes** only through Prisma migrations (`packages/db/prisma/migrations`). Additive
  (expand) changes only; never drop or rename a column in the same change that stops using it.
- **Security:** never log secrets or personal data; validate every request body; check roles on every
  endpoint; never weaken an existing guard.
- **Dependencies:** add only what the approved plan lists; prefer existing ones.

## Commands (all must pass before a change is done)

```bash
pnpm install --frozen-lockfile
pnpm verify          # format:check, lint, typecheck, unit tests, build
pnpm test:e2e        # API HTTP tests
```
