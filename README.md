# EvolveSales

An AI-powered, self-evolving sales application. Business users request software changes in natural
language (web or WhatsApp); an AI agent analyses this repository and proposes a plan; an administrator
approves; an isolated AI coding agent implements the change, runs the tests and opens a pull request
for human review.

> **Status:** Phase 3 (repository analysis) in review; Phases 1, 2a and 2b are merged. A submitted
> request is analysed only once the GitHub App, the Anthropic key, the runner image and the spend caps
> are set up ([docs/GITHUB_APP_SETUP.md](docs/GITHUB_APP_SETUP.md)); until then it ends in **Failed**
> with the reason. See [docs/IMPLEMENTATION_PLAN.md](docs/IMPLEMENTATION_PLAN.md) for the full
> architecture, security design and phase plan.

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
cp .env.example .env        # set POSTGRES_PASSWORD (+ DATABASE_URL), JWT_ACCESS_SECRET, SEED_USER_PASSWORD
                            # and ANTHROPIC_API_KEY for the AI assistant
pnpm db:up                  # PostgreSQL on localhost:5432
pnpm db:migrate             # apply Prisma migrations
pnpm db:seed                # demo users, 15 customers, 25 products, 30 invoices
pnpm build
pnpm dev:api                # http://localhost:3000/api/v1/health  (Swagger: /api/docs)
pnpm dev:orchestrator       # job worker (health: http://localhost:3001/health)
pnpm dev:web                # http://localhost:5173
```

## Change requests (Phase 2a)

1. **Request a change** (header button) opens the AI assistant with the current screen's context.
   It can also answer read-only questions about invoices and customers (max 10 rows, audited).
2. The assistant fills a structured request card; **Submit request** creates `CR-0001`, … in
   `SUBMITTED` and queues an `analyze` job.
3. The Orchestrator picks the job up. Until the analysis agent arrives in Phase 3 it records a failed
   job and moves the request to **Failed** with the reason "Analysis agent not configured". It never
   invents a plan.
4. Approvers use **Approvals** to approve, reject (reason required) or ask for clarification. A
   requester cannot approve their own request; an Admin can, but only with an audited reason.
   Approval authorizes coding only.
5. Every status change is written to an append-only history and the audit log, notifies the people
   involved (bell icon) and updates open browsers live over Socket.IO.

## WhatsApp (Phase 2b)

Off unless `WHATSAPP_ENABLED=true`. Setup (Meta test number, ngrok, templates): [docs/WHATSAPP_SETUP.md](docs/WHATSAPP_SETUP.md).

- **Link a phone** on the **Profile** page (account menu): the page shows a code, and you send
  `LINK <code>` to the bot _from that phone_. Unknown numbers get one fixed reply and never reach the AI.
- Chat with the same assistant as the web drawer: data questions (read-only, as you), change requests
  with a screen list and a **Submit request** button. Commands: `help`, `new`, `status`, `pending`, `cancel`.
- **Approvers** get approval cards (Approve / Reject / Clarify). Approve asks for the 6-digit
  **approval PIN** set on the Profile page (5 wrong PINs lock WhatsApp approvals for 30 minutes).
  Buttons are signed, single-use and expire after 24 hours; decisions are audited with channel `WHATSAPP`.
- Status, clarification and approval notifications go to WhatsApp too, per your Profile preferences;
  after Meta's 24-hour window they use approved templates.

## Repository analysis (Phase 3)

Setup (GitHub App, runner image, proxies, caps): [docs/GITHUB_APP_SETUP.md](docs/GITHUB_APP_SETUP.md).

- When a request is submitted, the Orchestrator does the following:
  1. Checks the admin's **spend caps**. There are no defaults.
  2. Resolves `main` of the one **authorized repository** to a baseline commit.
  3. Starts a single-use **agent-runner** container: non-root, read-only, no capabilities, internal
     network plus an allowlist egress proxy, with secrets on stdin only.
  4. The Claude Agent SDK, limited to Read/Grep/Glob inside a read-only checkout, writes a plan.
  5. The **PlanVerifier** checks every cited excerpt against GitHub at that commit.
  6. The request moves to **Awaiting approval**, or to **Clarification required** if the agent asked
     questions.
- **Agents** page (admins): spend caps, and which repository the agents may use.
- **Request → Timeline:** a live log of each agent job, and its cost.
- **Request → Plan:** the verified plan.

```bash
pnpm agents:up
```

```bash
pnpm runner:build
```

Demo users (password = `SEED_USER_PASSWORD` from your `.env`):

| Email                        | Role            | Can                                                 |
| ---------------------------- | --------------- | --------------------------------------------------- |
| `sales@evolvesales.local`    | Sales           | create/edit own drafts, confirm, cancel own drafts  |
| `manager@evolvesales.local`  | Sales manager   | all of the above + edit any draft, cancel confirmed |
| `approver@evolvesales.local` | Change approver | read invoices (approves AI changes from Phase 2)    |
| `release@evolvesales.local`  | Release manager | read invoices (approves releases from Phase 5)      |
| `admin@evolvesales.local`    | Admin           | everything                                          |

## Invoice rules (Phase 1)

- Numbers `INV-YYYY-000001`, allocated per year inside the creating transaction.
- Per line: gross = qty × price → line discount % → invoice discount % (shared across lines) →
  tax at the product's rate → line total. Calculated by `packages/shared` (decimal.js, half-up to
  2 dp) in both the browser preview and the API; the API's result is the one stored.
- Draft → Confirmed → Cancelled. Only drafts can be edited (optimistic `version` check → 409).
  Cancelling a confirmed invoice needs a sales manager and a reason. Cancelled is final.
- Every change is written to the append-only `audit_logs` table (a DB trigger rejects UPDATE/DELETE).

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
