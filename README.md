# EvolveSales

An AI-powered, self-evolving sales application. Business users request software changes in natural
language (web or WhatsApp); an AI agent analyses this repository and proposes a plan; an administrator
approves; an isolated AI coding agent implements the change, runs the tests and opens a pull request
for human review.

> **Status:** Phase 0 (project bootstrap) complete. See [docs/IMPLEMENTATION_PLAN.md](docs/IMPLEMENTATION_PLAN.md)
> for the full architecture, security design and phase plan.

## Stack

NestJS 12 · React 19 + Vite + Mantine · PostgreSQL 17 · Prisma · pg-boss · Vitest · oxlint · pnpm
workspaces · Docker · GitHub Actions.

## Prerequisites

- Node.js 22 LTS (`.nvmrc`)
- pnpm 12 (`npm i -g pnpm@12` or `corepack enable pnpm`)
- Docker Desktop (Linux containers)

## Getting started

```bash
pnpm install
cp .env.example .env        # then set POSTGRES_PASSWORD (and DATABASE_URL to match)
pnpm db:up                  # PostgreSQL on localhost:5432
pnpm build
pnpm dev:api                # http://localhost:3000/api/v1/health
pnpm dev:orchestrator       # http://localhost:3001/health
pnpm dev:web                # http://localhost:5173
```

## Quality gate

```bash
pnpm verify      # format check, lint, typecheck, unit tests, build
pnpm test:e2e    # API HTTP tests
```

CI runs the same checks on every pull request ([.github/workflows/ci.yml](.github/workflows/ci.yml)).

## Repository layout

```
apps/api            NestJS HTTP API
apps/orchestrator   NestJS always-on worker
apps/web            React frontend
packages/shared     Shared types and business logic
deploy/             Docker Compose and infrastructure
docs/               Plan and design documents
```

Conventions for contributors and AI agents: [AGENTS.md](AGENTS.md).
