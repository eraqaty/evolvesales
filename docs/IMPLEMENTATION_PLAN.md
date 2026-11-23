# EvolveSales — Detailed Implementation Plan (NestJS edition)

> Status: **Approved 2026-11-19; being built phase by phase.** Phases 0–2b merged; Phase 3 in review
> (PR #4) as of 2026-11-23. Current state and next steps: [HANDOFF.md](../HANDOFF.md).
> Originally drafted: 2026-11-19

---

## 0. Decisions already made

| Topic                               | Decision                                                                                                                                                                                          |
| ----------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Backend                             | **NestJS 11** (TypeScript, Node.js 22 LTS)                                                                                                                                                        |
| Frontend                            | React 19 + TypeScript + Vite, **Mantine**, TanStack Query, React Router                                                                                                                           |
| Database                            | PostgreSQL 16 (Supabase-compatible, no Supabase-only features)                                                                                                                                    |
| ORM / migrations                    | **Prisma**                                                                                                                                                                                        |
| Durable queue                       | **pg-boss** (same Postgres DB, `pgboss` schema)                                                                                                                                                   |
| Authentication                      | **Local accounts + JWT** (Passport, argon2, access + rotating refresh tokens)                                                                                                                     |
| GitHub credentials                  | **GitHub App** (short-lived installation tokens, read and write tokens kept separate)                                                                                                             |
| Default coding agent                | **Claude Agent SDK** (`@anthropic-ai/claude-agent-sdk`); **Codex SDK** (`@openai/codex-sdk`) can be selected instead                                                                              |
| Chat LLM abstraction                | Vercel AI SDK (`ai`, `@ai-sdk/anthropic`, `@ai-sdk/openai`) behind our own `LlmProvider` interface                                                                                                |
| Target repository                   | **Public** repo `eraqaty/evolvesales` on the personal account, with branch protection on `main` (see §18)                                                                                         |
| Agent spend caps                    | **You configure them.** Admin Settings screen + env; no built-in defaults. Agent jobs refuse to start until caps are set                                                                          |
| DB tests inside the agent container | **PGlite** (in-process Postgres); CI reruns everything on real Postgres                                                                                                                           |
| Separation of duties                | Requester can't approve their own CR; Admin override allowed with a mandatory, audited reason                                                                                                     |
| Staging                             | **Local Docker Compose stack deployed by a GitHub self-hosted runner on this PC**                                                                                                                 |
| Tax                                 | Per-product tax rate, computed per line after discounts                                                                                                                                           |
| Discounts                           | Line % discount + optional invoice-level % discount, spread across lines before tax                                                                                                               |
| Cancellation                        | Drafts: anyone with edit rights. Confirmed: reason + SalesManager/Admin. Cancelled is final                                                                                                       |
| Currency / numbering                | EGP; `INV-{YYYY}-{000001}`, yearly sequence, assigned when the draft is created                                                                                                                   |
| Package manager                     | pnpm 12 workspaces                                                                                                                                                                                |
| Versions (checked 2026-11-19)       | **NestJS 12** (ESM-only), TypeScript 6.0 (typescript-eslint/ts-jest don't support TS 7 yet), Vite 8, React 19.3, Mantine 9, Prisma 7.10 (stable; npm `latest` points to an 8.0 RC), PostgreSQL 17 |
| Tests / lint                        | **Vitest everywhere** (the NestJS 12 default; replaces Jest wherever this plan says Jest) and **oxlint** with type-aware rules (replaces ESLint), plus Prettier                                   |

---

## 1. Solution architecture

```
                    ┌──────────────────────── apps/web (React) ─────────────────────────┐
                    │ A Invoices │ B Request Assistant │ C Approvals │ D Execution Monitor │
                    └───────────────┬────────────── REST (/api/v1) + Socket.IO ─────────┘
                                    ▼
┌───────────────────────── apps/api (NestJS, always on) ──────────────────────────────────┐
│ AuthModule │ SalesModule (customers, products, invoices) │ AssistantModule (LLM chat)   │
│ ChangeRequestsModule (lifecycle, approvals) │ MonitorModule │ NotificationsGateway      │
│ AuditModule │ Health   ── enqueues jobs via pg-boss; NEVER runs agents or Docker ──    │
└───────────────┬───────────────────────────────────────────────────────────────────────┘
                ▼
      PostgreSQL: app schema (Prisma) + pgboss schema (queue)
                ▲
┌───────────────┴──────── apps/orchestrator (NestJS standalone worker, always on) ────────┐
│ Job handlers: analyze │ code │ pr-watch │ deploy-watch │ reaper                         │
│ LifecycleService (state machine) │ GitHubService (Octokit, App tokens)                  │
│ DockerLauncher (dockerode → docker-socket-proxy) │ DiffPolicyGate │ PlanVerifier         │
│ Publishes events → api (Postgres LISTEN/NOTIFY) → Socket.IO to browsers                 │
└───────────────┬───────────────────────────────────────────────────────────────────────┘
                ▼  one container per job, then destroyed
┌──────────── agent-runner image (Node 22 + git + pnpm + agent SDKs) ──────────────────────┐
│ MODE=analyze: clone@baseline → read-only tools → plan.json                               │
│ MODE=code:    clone@baseline → verify SHA → branch → agent edits → lint/typecheck/test/   │
│               build → commit → git bundle → result.json                                  │
│ Network: internal-only Docker network → egress-proxy (domain allowlist)                  │
└──────────────────────────────────────────────────────────────────────────────────────────┘

GitHub: PR → CI (GitHub-hosted runners) → human review → merge to main
     → deploy-staging.yml (self-hosted runner, this PC) → staging compose stack → smoke tests
     → deploy-production.yml (manual, environment approval, DISABLED in MVP)
```

### How the three components are kept apart

| Component               | Process                  | Lifetime  | Can touch source code?                   | Holds GitHub credentials?     |
| ----------------------- | ------------------------ | --------- | ---------------------------------------- | ----------------------------- |
| Request Assistant       | `apps/api`               | Always on | No (it has no tools that can)            | No                            |
| Orchestrator            | `apps/orchestrator`      | Always on | No (only pushes an already-gated bundle) | Yes: mints short-lived tokens |
| Coding / Analysis Agent | `agent-runner` container | One job   | Yes, inside its own clone only           | Read-only token only          |

---

## 2. Repository / project structure

```
evolvesales/
├─ apps/
│  ├─ api/                        NestJS HTTP + Socket.IO
│  │  └─ src/
│  │     ├─ auth/                 controller, jwt.strategy, roles.guard, refresh tokens
│  │     ├─ users/
│  │     ├─ sales/
│  │     │  ├─ customers/         list/search (read-only in MVP)
│  │     │  ├─ products/          list/search (read-only in MVP)
│  │     │  └─ invoices/          controller, service, dto, invoice-number.service
│  │     ├─ assistant/            conversations, llm chat, structured extraction
│  │     ├─ change-requests/      CRUD, approve/reject/clarify, plans, history
│  │     ├─ monitor/              jobs, logs, PRs, deployments (read APIs)
│  │     ├─ notifications/        gateway + REST
│  │     ├─ audit/                AuditService + interceptor
│  │     ├─ common/               filters, pipes (zod), pagination, config
│  │     └─ main.ts
│  ├─ orchestrator/               NestJS application context (no HTTP except /health)
│  │  └─ src/
│  │     ├─ jobs/                 analyze.handler, code.handler, pr-watch.handler,
│  │     │                        deploy-watch.handler, reaper.handler
│  │     ├─ docker/               docker-launcher.service, container-spec.ts
│  │     ├─ github/               app-auth.service, repo.service, pr.service, checks.service
│  │     ├─ policy/               diff-policy.gate, plan-verifier
│  │     └─ lifecycle/            uses packages/shared state machine + DB transition
│  └─ web/                        React app
│     └─ src/
│        ├─ features/invoices/    InvoiceListPage, InvoiceEditorPage, InvoiceDetailsPage
│        ├─ features/assistant/   RequestChangeDrawer, ChatThread, RequestSummaryCard
│        ├─ features/approvals/   ApprovalListPage, ApprovalDetailPage
│        ├─ features/monitor/     MonitorListPage, RequestTimelinePage, LiveLogViewer
│        ├─ features/auth/        LoginPage, AuthProvider
│        └─ lib/                  api client, socket, screen-context registry
├─ packages/
│  ├─ db/                         prisma/schema.prisma, migrations/, seed.ts, client export
│  ├─ shared/                     zod schemas, enums, invoice-calculator, lifecycle table,
│  │                              agent contracts (Job, Plan, Result)
│  └─ llm/                        LlmProvider interface + anthropic/openai adapters,
│                                 CodingAgent interface (types only)
├─ agent-runner/
│  ├─ Dockerfile
│  ├─ src/ entrypoint.ts, analyze.ts, code.ts, agents/claude.ts, agents/codex.ts,
│  │       tool-policy.ts, prompts/*.md
│  └─ policies/ bash-allowlist.json
├─ deploy/
│  ├─ compose.dev.yml             postgres, api, orchestrator, web, egress-proxy, socket-proxy
│  ├─ compose.staging.yml         same, separate project name/ports/DB, no agent features
│  ├─ egress-proxy/squid.conf     domain allowlist
│  └─ env/ .env.example, .env.staging.example
├─ e2e/                           Playwright: smoke + demo scenarios
├─ .github/workflows/ ci.yml, deploy-staging.yml, deploy-production.yml, rollback-staging.yml
├─ docs/ ARCHITECTURE.md, SECURITY.md, DEMO.md, GITHUB_APP_SETUP.md, IMPLEMENTATION_PLAN.md
├─ CLAUDE.md / AGENTS.md          conventions the coding agent must follow
└─ pnpm-workspace.yaml, package.json, tsconfig.base.json, .editorconfig, eslint, prettier
```

`CLAUDE.md` / `AGENTS.md` give the coding agent repo conventions: where features live, how to add an API endpoint, how to write tests, which commands must pass. This is deliberate, because it makes the agent's changes much more predictable.

---

## 3. Data model (Prisma, `public` schema)

**Identity**

- `User` (id uuid, email unique, displayName, passwordHash, roles Role[], isActive, createdAt)
- `RefreshToken` (id, userId, tokenHash, expiresAt, revokedAt, replacedById)
- `enum Role { SALES_USER, SALES_MANAGER, CHANGE_APPROVER, RELEASE_MANAGER, ADMIN }`

**Sales**

- `Customer` (id, code unique, name, taxNumber, email, phone, address, isActive)
- `Product` (id, sku unique, name, unit, unitPrice Decimal(18,2), taxRate Decimal(5,4), isActive)
- `InvoiceSequence` (year PK, lastValue int): incremented in the same transaction with `UPDATE … RETURNING`, so no gaps can come from races
- `Invoice` (id, number unique, customerId, status `DRAFT|CONFIRMED|CANCELLED`, issueDate, dueDate, currency='EGP', headerDiscountPct Decimal(5,2), subtotal, discountTotal, taxTotal, grandTotal, notes, createdById, confirmedById/At, cancelledById/At, cancelReason, **version int** for optimistic concurrency, timestamps)
- `InvoiceItem` (id, invoiceId, lineNo, productId, description, quantity Decimal(18,3), unitPrice, lineDiscountPct, taxRate _(copied from the product)_, lineGross, lineDiscount, headerDiscountShare, taxableAmount, taxAmount, lineTotal)

**Change management**

- `Repository` (id, owner, name, defaultBranch, installationId, isAuthorized)
- `ChangeRequest` (id, key `CR-0001` unique, title, requesterId, screen, screenContext Json, originalRequest text, structured Json, status, priority, repositoryId, baselineSha, branchName, currentPlanId, timestamps)
- `Conversation` (id, changeRequestId?, userId, screen, status) + `ConversationMessage` (id, conversationId, role `user|assistant|system`, content, metadata Json, createdAt)
- `ImplementationPlan` (id, changeRequestId, version, baselineSha, plan Json _(schema in §7)_, verifiedCount, assumptionCount, agent, model, createdAt)
- `ApprovalDecision` (id, changeRequestId, planId, decision `APPROVED|REJECTED|CLARIFICATION`, actorId, comment, createdAt)
- `StatusTransition` (id, changeRequestId, from, to, actorType `USER|SYSTEM`, actorId?, reason, metadata Json, createdAt), an append-only history
- `AgentJob` (id, changeRequestId, type `ANALYZE|CODE`, status `QUEUED|RUNNING|SUCCEEDED|FAILED|TIMED_OUT|CANCELLED`, agentKind, model, containerId, image digest, startedAt, finishedAt, exitCode, inputTokens, outputTokens, costUsd, error)
- `JobLog` (id bigserial, jobId, seq, stream `stdout|stderr|system|agent`, line, createdAt)
- `TestRun` (id, jobId, step `lint|typecheck|unit|integration|build`, status, durationMs, summary Json, outputExcerpt)
- `PullRequest` (id, changeRequestId, number, url, headBranch, headSha, ciState, reviewState, mergedAt, mergeSha, closedAt)
- `Deployment` (id, changeRequestId?, environment `STAGING|PRODUCTION`, sha, status, workflowRunUrl, smokeStatus, startedAt, finishedAt, rolledBackFromId?)
- `Notification` (id, userId, type, title, body, link, readAt, createdAt)
- `AuditLog` (id bigserial, actorId?, action, entityType, entityId, before Json?, after Json?, ip, userAgent, correlationId, createdAt). The app's DB role can only INSERT into this table (a migration revokes UPDATE and DELETE).

**Seed data:** 5 users (one per role, plus the requester as SALES_USER), about 15 customers, about 25 products with tax rates 14%, 5% and 0%, and about 30 invoices in mixed states. Seed passwords come from `SEED_*_PASSWORD` environment values, which are written into the local `.env` and are not committed.

---

## 4. Invoice business rules

### Calculation (in `packages/shared/invoice-calculator.ts`, used by both the UI preview and the API, which is authoritative)

For each line (decimal.js, ROUND_HALF_UP to 2 decimal places at each money step):

1. `lineGross = qty × unitPrice`
2. `lineDiscount = lineGross × lineDiscountPct/100`
3. `lineNet = lineGross − lineDiscount`
4. `headerDiscountShare = lineNet × headerDiscountPct/100` _(the same rate on every line is the same as a proportional allocation; any rounding remainder goes onto the largest line so totals reconcile exactly)_
5. `taxable = lineNet − headerDiscountShare`
6. `tax = taxable × taxRate`
7. `lineTotal = taxable + tax`

Invoice: `subtotal = Σ lineGross`, `discountTotal = Σ(lineDiscount + headerDiscountShare)`, `taxTotal = Σ tax`, `grandTotal = Σ lineTotal`.

Validation: qty > 0, unitPrice ≥ 0, both discount percentages between 0 and 100, at least one line to confirm, customer active, products active.

### Status rules

| Action       | Allowed from | Who                           | Effect                                        |
| ------------ | ------------ | ----------------------------- | --------------------------------------------- |
| Create draft | —            | SALES_USER+                   | Assigns the number, saves items and totals    |
| Edit         | DRAFT        | creator, SALES_MANAGER, ADMIN | Recalculates; version check (409 on conflict) |
| Confirm      | DRAFT        | SALES_USER+                   | Freezes prices and tax, sets confirmedAt      |
| Cancel       | DRAFT        | creator/manager/admin         | Optional reason                               |
| Cancel       | CONFIRMED    | SALES_MANAGER, ADMIN          | **Reason required**                           |
| Any change   | CANCELLED    | —                             | Rejected (final state)                        |

Every mutation writes an `AuditLog` row with a before/after snapshot.

### API (`/api/v1`)

- `GET /customers?search=` and `GET /products?search=` (for the select boxes)
- `GET /invoices?search=&status=&customerId=&dateFrom=&dateTo=&minTotal=&maxTotal=&page=&pageSize=&sort=`
- `GET /invoices/:id`, `POST /invoices`, `PUT /invoices/:id` (with `version`), `POST /invoices/:id/confirm`, `POST /invoices/:id/cancel {reason}`
- OpenAPI/Swagger at `/api/docs`

**Export to Excel is NOT implemented, and nothing is stubbed for it.**

---

## 5. Change-request lifecycle (state machine)

The transition table lives in `packages/shared/lifecycle.ts`, and the API and Orchestrator both use it. Every transition goes through `LifecycleService.transition(crId, to, actor, reason)`, which:

1. checks that the transition is allowed
2. checks the actor (USER with a required role, or SYSTEM)
3. runs `UPDATE change_request SET status=:to WHERE id=:id AND status=:from` (an optimistic guard that blocks double transitions)
4. inserts a `StatusTransition` row and an `AuditLog` row
5. creates notifications and emits a realtime event

All of this happens in one transaction.

| From                   | To                     | Actor                 | Trigger                                                                                                 |
| ---------------------- | ---------------------- | --------------------- | ------------------------------------------------------------------------------------------------------- |
| —                      | SUBMITTED              | Requester             | Assistant submit                                                                                        |
| SUBMITTED              | ANALYZING              | SYSTEM                | `analyze` job started                                                                                   |
| ANALYZING              | AWAITING_APPROVAL      | SYSTEM                | Plan stored and verified                                                                                |
| ANALYZING              | CLARIFICATION_REQUIRED | SYSTEM                | Agent reports blocking ambiguity                                                                        |
| ANALYZING              | FAILED                 | SYSTEM                | Job error or timeout                                                                                    |
| AWAITING_APPROVAL      | APPROVED               | CHANGE_APPROVER/ADMIN | Approve (comment optional)                                                                              |
| AWAITING_APPROVAL      | REJECTED               | CHANGE_APPROVER/ADMIN | Reject (comment required)                                                                               |
| AWAITING_APPROVAL      | CLARIFICATION_REQUIRED | CHANGE_APPROVER/ADMIN | Questions to the requester                                                                              |
| CLARIFICATION_REQUIRED | SUBMITTED              | Requester             | Answers in the assistant, which triggers re-analysis                                                    |
| APPROVED               | ANALYZING              | SYSTEM                | Baseline drift touches affected files (revalidation)                                                    |
| APPROVED               | CODING                 | SYSTEM                | `code` job container started                                                                            |
| CODING                 | TESTING                | SYSTEM                | Agent finished editing; runner runs the checks                                                          |
| CODING / TESTING       | FAILED                 | SYSTEM                | Agent error, tests failing after the allowed fix attempts, policy gate violation, timeout               |
| TESTING                | PULL_REQUEST_CREATED   | SYSTEM                | Checks passed, gate passed, branch pushed, PR opened                                                    |
| PULL_REQUEST_CREATED   | REVIEW                 | SYSTEM                | CI checks on the PR head are green                                                                      |
| PULL_REQUEST_CREATED   | FAILED                 | SYSTEM                | CI red (the PR stays open; a human can fix it)                                                          |
| REVIEW                 | STAGING                | SYSTEM                | PR merged **and** staging deploy and smoke tests succeeded for the merge SHA                            |
| REVIEW                 | REJECTED               | SYSTEM                | PR closed without merging                                                                               |
| STAGING                | PRODUCTION_APPROVAL    | SYSTEM                | Staging smoke passed; waiting for release approval                                                      |
| PRODUCTION_APPROVAL    | RELEASED               | RELEASE_MANAGER       | Production workflow succeeded _(workflow disabled in the MVP, so the demo ends at PRODUCTION_APPROVAL)_ |
| FAILED                 | APPROVED               | ADMIN                 | Retry coding with the same plan                                                                         |
| FAILED                 | SUBMITTED              | ADMIN                 | Re-analyse from scratch                                                                                 |

Approving **only** authorizes coding. Merging needs a GitHub review, and production needs RELEASE_MANAGER plus the GitHub environment rule.

---

## 6. AI Request Assistant (Screen B)

**UI.** A "Request a Change" button in the invoice page header opens a Mantine `Drawer` containing:

- the chat thread
- a context chip showing what is captured
- a live **structured request card** that updates as the conversation goes
- a "Submit request" button (enabled when the request is complete)
- a status badge with a link to the monitor once submitted

**Screen context capture.** Each page registers a context provider through `useScreenContext()`. It records:

- `screen` (`sales.invoices.list` / `.editor` / `.details`)
- the route and active filters
- visible columns and the selected invoice id
- app version (git SHA baked into the build)
- browser locale

The authenticated user comes from the JWT on the server side and is never trusted from the client body.

**Server flow** (`POST /assistant/conversations`, `POST /assistant/conversations/:id/messages`, streamed as SSE):

1. Persist the user message.
2. Call `LlmProvider.chat()` with:
   - a **system prompt**: role, domain glossary, rules ("you cannot change code; you collect requirements; ask at most 3 clarification questions; never promise delivery")
   - the screen context **as delimited data**
   - the conversation history
3. The LLM may call exactly two tools:
   - `ask_clarification({questions[]})`
   - `propose_change_request({title, category, description, screen, userStory, acceptanceCriteria[], outOfScope[], priority, assumptions[]})`
4. Validate the proposal with zod, store it on the conversation, and show it as the summary card.
5. The user presses **Submit** (an explicit human action). The server creates the `ChangeRequest` (`SUBMITTED`), links the conversation, and enqueues `analyze`.

**Limits:** max 20 messages per conversation, max 4,000 characters per message, and per-user rate limiting (`@nestjs/throttler`).

**Provider config:** `LLM_PROVIDER=anthropic|openai`, `LLM_MODEL=…` (default Anthropic `claude-sonnet-5-5`; you choose the OpenAI model name).

---

## 7. Repository Analysis Agent

**Job `analyze` (Orchestrator):**

1. Load the CR and its repository; resolve `main` HEAD SHA through the GitHub API, which becomes `baselineSha`.
2. Mint a **read-only** installation token (`contents:read`, scoped to this one repo, about 1 hour).
3. Start a container (§9) with `MODE=analyze`. Input goes in `/job/input.json`: CR structured request, original text, screen context, baseline SHA, schema. The token goes in a mounted file and is deleted from memory after use.
4. Runner: `git clone --filter=blob:none` at the baseline, check out the exact SHA, `chmod -R a-w /workspace/repo`.
5. Run the Claude Agent SDK `query()` with:
   - `allowedTools: ["Read","Grep","Glob"]`, with `disallowedTools` covering Bash, Write, Edit and WebFetch
   - a `canUseTool` hook that denies any path outside `/workspace/repo`
   - `maxTurns: 40` and a budget cap
   - output format forced to the plan JSON schema
6. The runner writes `/out/plan.json` plus the agent transcript (as `JobLog` lines).
7. Orchestrator **PlanVerifier**:
   - Every "verified" finding must cite `{path, startLine, endLine, excerpt}`.
   - The verifier checks that the path exists at `baselineSha` (GitHub tree API) and that the excerpt appears in the file at about those lines.
   - Findings that fail are **downgraded to assumptions** and flagged.
8. Store `ImplementationPlan` v(n), then transition to `AWAITING_APPROVAL` (or to `CLARIFICATION_REQUIRED` if `blockingQuestions` is not empty).

**Plan schema (zod):**

```
originalRequest, technicalInterpretation,
proposedImplementation: [{step, description}],
affectedComponents: [{layer: frontend|backend|database|tests|config, path, change: add|modify|delete,
                      reason, evidence?: {path,startLine,endLine,excerpt}, verified: bool}],
databaseChanges: {required: bool, migrations: [...], dataImpact},
newDependencies: [{name, version, justification}],
testRequirements: [{type: unit|integration|e2e, description, path}],
risks: [{category: security|compatibility|performance|data, description, severity, mitigation}],
complexity: {level: S|M|L|XL, rationale, estimatedFilesChanged},
acceptanceCriteria: [...],
assumptions: [...], blockingQuestions: [...]
```

---

## 8. Approval Dashboard (Screen C)

- **List:** CR key, title, requester, screen, status, complexity, risk (highest severity), age; filters by status.
- **Detail:**
  - original request and conversation transcript
  - the plan, rendered with **Verified** (green, evidence link to GitHub at the baseline SHA) and **Assumption** (amber) badges
  - affected files table, DB changes, new dependencies
  - risk matrix and acceptance criteria
  - plan version selector, baseline SHA
  - approval history and status timeline
- **Actions** (CHANGE_APPROVER/ADMIN only, enforced server-side):
  - Approve
  - Reject (comment required)
  - Request Clarification (questions required; these appear in the requester's assistant panel and notifications)
- A requester cannot approve their own request, even if they hold the role (separation of duties; ADMIN can override, and the override is audited).

---

## 9. Agent container isolation (both modes)

| Control          | Setting                                                                                                                                                                                                                                                                    |
| ---------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Image            | `evolvesales/agent-runner:<digest>`, pinned by digest, built in CI                                                                                                                                                                                                         |
| User             | uid 10001, non-root                                                                                                                                                                                                                                                        |
| Root filesystem  | read-only; writable `tmpfs` for `/workspace`, `/tmp`, `/home/agent` (size-limited)                                                                                                                                                                                         |
| Output           | per-job named volume mounted at `/out` (the Orchestrator reads it after exit)                                                                                                                                                                                              |
| Capabilities     | `CapDrop: ALL`, `no-new-privileges`, default seccomp, no privileged mode                                                                                                                                                                                                   |
| Resources        | 2 CPUs, 4 GB RAM, 512 PIDs; wall clock: analyze 15 min, code 45 min (killed after)                                                                                                                                                                                         |
| Network          | attached **only** to the internal network `agent-net` (no default route); `HTTPS_PROXY=http://egress-proxy:3128`                                                                                                                                                           |
| Egress allowlist | github.com, codeload.github.com, objects.githubusercontent.com, api.anthropic.com, api.openai.com, registry.npmjs.org, binaries.prisma.sh. Everything else is denied and logged                                                                                            |
| Mounts           | No Docker socket, no host paths, no `.env`                                                                                                                                                                                                                                 |
| Secrets          | GitHub **read** token + AI key in a tmpfs secret file, never in `docker inspect`-visible env. No database credentials of any kind. There is no Docker inside the container, so DB integration tests run in CI, or against an in-process PGlite database (open question Q4) |
| Labels           | `evolvesales.job=<id>` so the reaper can clean up orphans on restart                                                                                                                                                                                                       |
| Cleanup          | `finally`: stop, remove the container, remove the volume after harvesting                                                                                                                                                                                                  |

The Orchestrator reaches Docker through **docker-socket-proxy**, which allows only containers, images, volumes and networks (no exec into other containers, no swarm, no system calls).

---

## 10. Coding Agent (job `code`)

1. **Drift check.** Compare `main` HEAD with `baselineSha`. If it moved, get the changed files. If any overlap the plan's affected files, transition `APPROVED → ANALYZING` (revalidation). Otherwise keep the approved baseline.
2. Mint a **read-only** token and start the container with `MODE=code`. Input: the approved plan (exactly the approved version), CR key, baseline SHA, branch name `evolve/CR-0007-export-invoices-excel`.
3. Runner:
   - a. Clone, check out `baselineSha`, **assert `git rev-parse HEAD == baselineSha`**.
   - b. `git switch -c <branch>`, then `pnpm install --frozen-lockfile`.
   - c. Run the agent (Claude Agent SDK, `permissionMode: "acceptEdits"`). The prompt contains the approved plan **as data**, the repo `CLAUDE.md` rules and the required checks.
     - Tools: Read, Write, Edit, Glob, Grep, Bash.
     - `canUseTool` restricts Bash to an allowlist (`pnpm <script>`, `pnpm add <pkg>` _(only packages in the plan)_, `pnpm prisma migrate dev --create-only`, `git status|diff|log`, `node`, `ls`, `cat`). It denies `git push`, `git remote`, `curl`, `wget`, environment dumps, and paths outside the repo.
     - `maxTurns 120`, budget cap.
   - d. Transition to TESTING (reported through `/out/progress.json` + logs, which the Orchestrator tails).
   - e. The **runner itself, not the agent,** runs `pnpm lint`, `pnpm typecheck`, `pnpm test` (unit), `pnpm build`. If a step fails, the output goes back to the agent for **up to 2 fix rounds**, then the checks run again.
   - f. Results go to `/out/tests.json`.
   - g. `git commit` (author `evolvesales-bot`, trailer `Change-Request: CR-0007`, `Plan-Version: 2`), then `git bundle create /out/change.bundle <baseline>..HEAD`.
   - h. The runner writes `/out/result.json` (status, summary, files changed, token usage).
4. Orchestrator **DiffPolicyGate**, run on the bundle:
   - Reject changes to `.github/**`, `deploy/**`, `agent-runner/**`, `**/.env*`, `CLAUDE.md`/`AGENTS.md`, lockfile changes not explained by `newDependencies`, files over 1 MB, binaries, and diffs over 3,000 lines.
   - Secret scan with gitleaks rules.
   - Warn if the changed files are not a subset of the plan's affected files plus tests. These are flagged in the PR body and on the dashboard, not blocked.
5. Mint a **write** token (`contents:write`, `pull_requests:write`, this repo only), push **only** the feature branch (refuse any ref named `main`), then open the PR. The PR body contains the CR link, original request, plan summary, acceptance criteria, test results, policy warnings and a "Generated by EvolveSales agent" label.
6. Save `PullRequest`, transition to `PULL_REQUEST_CREATED`, enqueue `pr-watch`.

**Codex alternative:** the same contract through `@openai/codex-sdk` with `sandbox: "workspace-write"` and approval policy `never`, inside the same container. The runner's outer tool restrictions are weaker for Codex (it runs its own shell), so the policy gate and the network allowlist are the main controls there. This is documented.

---

## 11. GitHub integration

- **GitHub App "EvolveSales Agent"** (you create it; I write step-by-step docs):
  - permissions: Contents RW, Pull requests RW, Checks R, Actions R, Deployments R, Metadata R, Commit statuses R
  - no webhooks in the MVP (the Orchestrator polls; localhost isn't reachable by GitHub)
  - installed only on `eraqaty/evolvesales`
- **Token minting:** `@octokit/auth-app`, with per-job tokens narrowed by the `repositories` and `permissions` parameters.
- **Repository authorization:** an admin page lists the App's installation repos and marks the allowed one (`Repository.isAuthorized`). Jobs refuse unauthorized repos.
- **Branch protection on `main`:**
  - require a PR, 1 approving review, the `ci` status check, linear history
  - block force-push and deletion, include administrators
  - **note:** private-repo branch protection needs GitHub Pro/Team (see Q1)
- **`pr-watch` job** (every 60 s until terminal): check runs on the head SHA → ciState; reviews → reviewState; merged/closed. Each update drives a transition.
- **`deploy-watch` job:** after the merge, find the `deploy-staging` workflow run for the merge SHA and wait for it to complete, then record a `Deployment` with smoke results.

---

## 12. CI/CD

**`ci.yml`** runs on pull_request and push to main, on **GitHub-hosted runners only**:

- pnpm install
- `prisma validate` + `migrate deploy` against a service Postgres
- lint, typecheck
- unit tests (Jest for the API, Vitest for the web app)
- integration tests (Supertest + service Postgres)
- build, `docker build` of api, orchestrator, web

AI-written PR code **never runs on the self-hosted runner**.

**`deploy-staging.yml`** runs on push to `main` (after merge) on `runs-on: [self-hosted, evolvesales-staging]`:

- build images tagged `sha-<short>`
- `prisma migrate deploy` on the staging DB
- `docker compose -p evolvesales-staging up -d` (web :8081, api :3101, separate Postgres volume)
- wait for health
- **Playwright smoke suite** (login, list invoices, create/confirm invoice, plus any smoke tests the PR added)
- create a GitHub Deployment with its status

**`rollback-staging.yml`** (`workflow_dispatch`, input `sha`): redeploys the previous image tag. Migrations are forward-only; a rollback of schema changes requires a down migration written in the PR. This is documented as a limitation.

**`deploy-production.yml`** (`workflow_dispatch`): `environment: production` (required reviewer = you) and `if: vars.PRODUCTION_ENABLED == 'true'`. **Disabled.** The agent's GitHub App has no Actions write or Environments permission, so it cannot trigger deployments.

---

## 13. Execution Monitor (Screen D)

- **List:** all CRs with status pills, current job, PR number, CI state, staging state; filters.
- **Request timeline:**
  - vertical lifecycle timeline (StatusTransition)
  - jobs with duration, model, tokens and cost
  - **live log viewer** (Socket.IO stream from `JobLog`, with "follow" toggle and download)
  - TestRun table, PR card with check runs and reviews, deployment cards with workflow-run links and smoke results
  - errors highlighted
- **Admin actions:** cancel a running job (kills the container), retry failed (FAILED → APPROVED/SUBMITTED).

---

## 14. Authentication, authorization and security summary

- **Auth:**
  - login → access JWT (15 min, in memory) + refresh token (7 days, httpOnly SameSite=Strict cookie, rotated, reuse detection revokes the family)
  - argon2id hashes, login throttling, lockout after 10 failures
- **RBAC:** `@Roles()` + `RolesGuard` on every controller; resource checks in services (for example, edit your own drafts). Socket.IO connections authenticate with the JWT, and rooms are filtered by role.
- **Audit:** global interceptor for mutating requests + explicit domain audit events; append-only table; correlation id per request.
- **Secrets:** `.env` (git-ignored) for dev, separate `.env.staging` on the runner host, GitHub Actions secrets for CI. The App private key is a file mounted read-only into the Orchestrator only. `config` validated with zod at boot (fail fast).
- **Prompt-injection defences:**
  1. User text and repository content are always wrapped as delimited _data_, with system prompts stating they're untrusted.
  2. The Assistant has no code or system tools.
  3. The analysis agent is read-only, and its claims are verified against the repo.
  4. The coding agent receives only the human-approved plan.
  5. Tool allowlists and path jails.
  6. Network allowlist.
  7. No secrets other than a read token and an AI key with a spend limit.
  8. DiffPolicyGate + secret scan.
  9. CI + mandatory human PR review.
  10. Production behind separate approval.
- **Web hardening:** helmet, strict CORS (web origin only), zod validation on every DTO, Prisma parameterised queries, rate limits, no stack traces in responses.
- **Agent cost/limits:** per-job `maxBudgetUsd` (default $5 analyze, $15 code, configurable) and a global daily cap checked before dispatch.

---

## 15. Testing strategy

| Layer            | Tooling                                                                    | Key cases                                                                                                                                                |
| ---------------- | -------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| shared           | Jest                                                                       | Calculator (rounding, header discount allocation, 0% tax, 100% discount), lifecycle table (every allowed/forbidden pair)                                 |
| api unit         | Jest                                                                       | Invoice service rules, RBAC guard, LifecycleService guards, assistant tool parsing                                                                       |
| api integration  | Jest + Supertest + Testcontainers Postgres (local) / service Postgres (CI) | Invoice CRUD, confirm, cancel, number sequence under concurrency, approval endpoints with each role                                                      |
| orchestrator     | Jest                                                                       | DiffPolicyGate fixtures, PlanVerifier, drift detection, container spec (limits/network/mounts asserted), GitHub service against recorded fixtures (nock) |
| web              | Vitest + React Testing Library                                             | Invoice editor totals, form validation, assistant drawer flows, approval actions hidden without role                                                     |
| e2e              | Playwright                                                                 | Smoke suite (also staging), full invoice flow, change-request UI flow up to approval                                                                     |
| live integration | Manual / scripted (`pnpm demo:verify`)                                     | Real GitHub App token, real container run, real PR. Reported only after it has actually run                                                              |

---

## 15a. Phases, tasks and exit criteria

### Phase 0: Bootstrap

- [ ] corepack enable pnpm; scaffold the monorepo, tsconfig, eslint/prettier, husky (optional)
- [ ] `compose.dev.yml` with Postgres 16; `.env.example`
- [ ] `git init`, create the **public** repo `eraqaty/evolvesales` with gh, push the initial commit, turn on branch protection, secret scanning and push protection
- **Exit:** `pnpm install && pnpm lint && pnpm typecheck` green; repo exists on GitHub.

### Phase 1: Business application

- [ ] Prisma schema (identity + sales), first migration, seed
- [ ] Auth module (login/refresh/logout/me), RBAC guard, audit module
- [ ] Customers/products read APIs; invoices API with all rules; Swagger
- [ ] Shared calculator + unit tests
- [ ] Web: login, app shell, invoice list (search/filter/paging), editor (customer/product selects, lines grid, live totals, save draft, confirm), details, cancel dialog
- [ ] API integration tests, web component tests, Playwright invoice flow
- [ ] `ci.yml`
- **Exit:** all tests green locally and in GitHub Actions; manual check in the browser preview.

### Phase 2: Request management

- [x] Prisma: change-management tables; lifecycle module; pg-boss setup in the API (publish) and Orchestrator (consume)
- [x] LlmProvider (Anthropic + OpenAI), assistant endpoints with SSE, tools, persistence
- [x] Web: Request a Change drawer, screen-context registry, summary card, submit, status badge
- [x] Approval dashboard (list/detail/actions), notifications (Socket.IO + bell), monitor list + timeline (no jobs yet)
- [x] Orchestrator skeleton with a health endpoint; `analyze` handler stubbed to **fail explicitly** ("analysis agent not configured") rather than fake a plan
- [x] Read-only **data tools** for the assistant (§19.4), shared by web and WhatsApp
- **Exit 2a:** a real conversation with a real LLM creates a CR; approve, reject and clarify transitions work with role enforcement; audit rows written. _(Needs an AI key.)_

**Phase 2a implementation notes (2026-11-20)**

- The lifecycle rules live in `packages/shared/src/change-request/lifecycle.ts`; the transactional `transitionChangeRequest()` (guarded UPDATE, history, audit, notifications, `pg_notify`) lives in `packages/db/src/lifecycle.ts`, so the API and the Orchestrator share one implementation.
- `LlmProvider` is in `apps/api/src/assistant/` (not a separate `packages/llm`) because only the API uses chat models today; the agent-runner in Phase 3 uses the Agent SDKs directly. It can move to a package when a second consumer appears.
- Tests drive the real assistant code with the AI SDK's `MockLanguageModelV4` (scripted responses), so tool execution, validation, persistence and streaming are covered without network calls. Only Exit 2a's "real LLM" check needs your API key.
- `analyze` jobs are enqueued inside the same transaction as the status change (`pg-boss` `fromPrisma(tx)`), so a job exists if and only if the change committed.
- Screens C and D share one request detail page (`/requests/:id`) with Request / Plan / Timeline tabs; `/approvals` is the approver's list filtered to "Awaiting approval".
- Realtime: lifecycle transitions `NOTIFY evolvesales_events` (delivered on commit, from either process); the API relays ids only to Socket.IO rooms `user:<id>` and `role:<role>`; browsers re-fetch through the authorised REST API.
- Until Phase 3, every submitted request ends in `FAILED` ("Analysis agent not configured"), so approve/reject/clarify cannot be reached from the UI with real data yet. Those transitions are covered by integration tests that place a request in `AWAITING_APPROVAL` directly in the test database.
- The workspace export condition was renamed from `source` to `evolvesales-source`, because the AI SDK's `eventsource-parser` also publishes a `source` condition.

#### Phase 2b: WhatsApp channel (details in §19)

- [x] Phone linking + approval PIN in the user profile
- [x] Webhook (signature check, idempotency, queue), WhatsApp client, delivery-status tracking
- [x] Channel-agnostic conversation engine + WhatsApp renderer (text, reply buttons, list messages)
- [x] Approval cards with Approve / Reject / Clarify + PIN step; notification templates
- [x] Tunnel exposing only `/webhooks/whatsapp` (`tools/ngrok/whatsapp-only.yml`)
- **Exit 2b:**
  - From a real phone on the Meta test number, a sales user asks a data question and gets a correct, role-limited answer.
  - The same user submits a change request.
  - The admin's phone receives the approval card; Approve + PIN moves the CR to APPROVED.
  - The web dashboard shows the same history, with channel = WHATSAPP in the audit log.

**Phase 2b decisions (2026-11-20)**

- Build all of 2b now. The live checks for the data question and the WhatsApp submission run once P6/P7 are ready. The live **Approve + PIN** check runs right after Phase 3, because no request can reach `AWAITING_APPROVAL` before the analysis agent exists; until then, integration tests cover approval cards.
- Phone linking: the user sends the code from WhatsApp (§19.3).
- P6/P7 are not ready yet. Development and tests use recorded Meta webhook payloads and a local fake Graph API; `docs/WHATSAPP_SETUP.md` walks through the Meta and ngrok setup.

**Phase 2b implementation notes (2026-11-20)**

- **One engine:** the WhatsApp worker calls the same `AssistantService` as the web drawer, so it shares tools, limits, persistence and submission. That service already emits channel-neutral events, so no separate `ConversationEngine` class was needed. WhatsApp conversations get a WhatsApp section in the system prompt and an `ask_screen` tool, which renders as a list message.
- **Worker:** inbound messages are stored (`inbound_channel_events`, unique wamid) and enqueued on the pg-boss queue `whatsapp-inbound` in one transaction. The API consumes the queue one message at a time. The webhook verifies `X-Hub-Signature-256` over the raw body and answers 404 when WhatsApp is disabled.
- **Notifications:** the existing notification rows drive WhatsApp delivery. A dispatcher claims each row with a guarded UPDATE (`whatsapp_handled_at`), so several API instances never send it twice. Notifications older than one hour are not sent to WhatsApp.
- **24-hour window:** tracked per user (`users.whatsapp_last_inbound_at`) instead of per conversation, because notifications are not tied to a conversation.
- **PINs:** a message received while the bot waits for a PIN is overwritten in `inbound_channel_events` and never reaches the LLM. A step that expired less than 30 minutes ago still catches a late PIN. Weak PINs (one repeated digit, a straight run) are refused, and setting a PIN requires the account password.
- **Separation of duties on WhatsApp:** nobody can decide on their own request from WhatsApp, and approvers get no card for it. An admin self-approval with a reason stays a web-only action.
- **Tests:** the Graph API is replaced by a local HTTP server (`apps/api/test/fake-graph.ts`) through `WHATSAPP_GRAPH_BASE_URL`, instead of nock. This needs no new dependency and also exercises the real `fetch` path.
- **Live verification (Exit 2b)** is still open. It needs P6/P7, and the Approve + PIN step needs Phase 3.

### Phase 3: Repository analysis

- [x] GitHub App auth service, repository authorization page
- [x] agent-runner image (analyze mode), egress proxy, docker-socket-proxy, DockerLauncher with limits
- [x] Claude analysis agent; plan schema; PlanVerifier; log streaming _(Codex alternative deferred, see decisions)_
- **Exit:** a real CR produces a real plan that cites real files in `eraqaty/evolvesales` at a recorded SHA; container gone afterwards (verified with `docker ps -a`). _(Needs Docker running, App credentials, AI key.)_ **Not run yet:** it needs the GitHub App (P3) and an Anthropic key.

**Phase 3 decisions (2026-11-22)**

- **GitHub App:** not created yet. Phase 3 ships `docs/GITHUB_APP_SETUP.md` and is built and tested against a fake GitHub API; the live exit runs once you have created and installed the App (P3).
- **Spend caps:** no built-in defaults (§0 wins over the "$5 default" in §14). Analyze jobs refuse to start until an admin sets the per-job and daily caps on the Agent settings page.
- **Agents:** Claude only in Phase 3, behind the existing `AnalysisAgent` interface. The Codex alternative is deferred until an OpenAI key is available to verify it.
- **Runner image:** built locally and pinned by digest for Phase 3; building it in CI moves to Phase 5.

**Phase 3 implementation notes (2026-11-22)**

- **Secrets go to the runner on stdin**, not in a mounted secret file (§7 step 3, §9).
  - The Orchestrator writes one JSON line `{input, secrets}`; nothing secret is in env, labels or `docker inspect`, and no volume or host path is involved.
  - The runner writes the GitHub token to its tmpfs only for `git fetch`, where a credential helper reads it, and then deletes it.
  - The runner reads one line and stops. The Orchestrator never half-closes the stream, because on a Windows named pipe that also closes the output (found by the Docker tests).
- **Results come back as JSON lines on stdout**, not through a per-job `/out` volume.
  - Each log line goes to `job_logs` live.
  - The last `result` event carries the plan; the Orchestrator validates it again.
  - Output is capped at 8 MB per job.
- **Checkout:**
  - `git fetch --depth 1` of the exact baseline SHA, with hooks, file transport, submodules and redirects disabled.
  - HEAD must equal the baseline.
  - Then `.git` and all symlinks are deleted, and the tree is made read-only.
  - The Orchestrator also rejects a plan whose reported commit differs from the baseline.
- **Agent:**
  - The Claude Agent SDK runs with `tools` and `allowedTools` set to Read/Grep/Glob, with Bash, Write, Edit, Web, Task and Skill also listed as disallowed.
  - `permissionMode: 'dontAsk'`.
  - A `PreToolUse` hook enforces the path guard, resolving symlinks, outside `/workspace/repo`. A `canUseTool` callback isn't called for every call, so a hook is used instead.
  - `settingSources: []` and no MCP servers, so repository `.claude/` settings, hooks and `CLAUDE.md` are ignored.
  - `maxTurns` 40, `maxBudgetUsd` = the job's cap, output forced to the plan JSON schema.
  - The subprocess gets an explicit, minimal environment. The default model is `claude-opus-5-5` (`AGENT_ANALYZE_MODEL`).
- **PlanVerifier:**
  - A component is verified only if its cited excerpt appears in the file at the baseline, within ±10 lines, ignoring indentation and blank lines.
  - A `modify` or `delete` component must name an existing file; an `add` component must name a new one.
  - Failed claims are downgraded, explained per component, and added to the assumptions.
- **Egress proxy:**
  - `apps/egress-proxy` is a small Node CONNECT proxy with no dependencies, used instead of Squid.
  - It allows only port 443 to allowlisted host names; IP literals and plain HTTP are refused.
  - It logs one JSON line per decision.
- **docker-socket-proxy:** the image's default rules would allow `exec`, `archive`, `export` and `update` on any container, so a custom rule file (`deploy/docker-socket-proxy/`) allows only the 8 calls the launcher makes.
- **Spend caps:**
  - They live in the `agent_settings` table and are edited on the admin **Agents** page; there is no env fallback.
  - The daily window is the UTC day.
  - In-flight jobs count with their full cap, and the budget decision is serialised with an advisory lock.
- **Repositories:**
  - The API holds no GitHub credentials. The Orchestrator syncs the App's installation repositories into `repositories` (at start-up, every 30 minutes, and on the admin's "Refresh", queue `github-repo-sync`).
  - A repository the App loses access to is de-authorized.
  - Exactly one repository may be authorized in the MVP.
- **Image pinning:**
  - In development, `AGENT_RUNNER_IMAGE` may be a tag. The launcher inspects it, runs it by image ID and records the digest on the job.
  - In production, the configuration requires `…@sha256:` (checked at boot).
- **Clarification:** when the agent returns blocking questions, the plan is stored and the request goes to `CLARIFICATION_REQUIRED` with those questions, reusing the Phase 2 answer flow.
- **Reaper:** at start-up, the Orchestrator removes leftover runner containers and fails jobs that were RUNNING, assuming a single Orchestrator instance.
- **Tests:**
  - Unit tests: plan schema, budget rule, redaction, path guard, agent options, container options, verifier, config.
  - Orchestrator integration tests: real PostgreSQL, a fake GitHub API and a stand-in agent.
  - Real-Docker tests (`*.docker-spec.ts`, also run in CI):
    - lockdown, timeout, removal and the reaper;
    - the full launcher through docker-socket-proxy with its refusals;
    - with the local stack up (skipped in CI): no direct route out, the allowlist, and the real runner image cloning `main` through the proxy.
  - API and web tests for the Agents page, job logs and the plan view.

### Phase 4: Coding agent

- [ ] Code mode in the runner, Bash allowlist, fix-round loop, bundle output
- [ ] DiffPolicyGate, push + PR creation, pr-watch job, drift revalidation
- [ ] Monitor: live logs, test runs, PR card; cancel/retry actions
- **Exit:** a harmless test CR (for example "add a tooltip to the Confirm button") produces a real PR with green CI. Policy-gate negative tests pass.

### Phase 5: End-to-end

- [ ] Register the self-hosted runner, `deploy-staging.yml`, staging compose, smoke suite, rollback workflow, disabled production workflow, deploy-watch job
- [ ] Branch protection
- [ ] **Live demo:** "Add an Export to Excel button to the Sales Invoice list" → plan → approve → PR → CI → you review and merge → staging → verify download in staging
- [ ] `DEMO.md` with screenshots and the actual CR/PR links; report anything that couldn't be verified
- **Exit:** the Excel export works on staging (:8081), and it was introduced only by the agent's PR.

### Phase 6: Production on Google Cloud (after local testing; details in §20.8)

- [ ] Terraform infrastructure for two GCP projects (`evolvesales-stg`, `evolvesales-prod`); GitHub → GCP through Workload Identity Federation (no stored keys); Secret Manager + service accounts
- [ ] `CloudRunJobLauncher`: agent runner moved to Cloud Run Jobs (no Docker socket), with locked-down egress
- [ ] Release pipeline: build once → staging → smoke → production approval → canary → automatic rollback
- [ ] Monitoring, alerts, backups, budget alerts; remove the self-hosted runner
- **Exit:** a second agent-made change goes from WhatsApp request to production with only the 3 human decisions (approve plan, review PR, approve release). A deliberately broken release rolls back automatically.

---

## 16. Prerequisites you need to provide

| #   | Item                                                                                                                                                                                                                | Needed by          |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------ |
| P1  | Start Docker Desktop (Linux engine); WSL2 memory ≥ 8 GB recommended                                                                                                                                                 | Phase 0 (Postgres) |
| P2  | Anthropic API key, ideally a dedicated one with a spend limit (OpenAI key optional)                                                                                                                                 | Phase 2            |
| P3  | Create the GitHub App by following `docs/GITHUB_APP_SETUP.md`, install it on the repo, save the private key `.pem` locally                                                                                          | Phase 3            |
| P4  | Register a self-hosted Actions runner on this PC (I provide the commands; you run the token step)                                                                                                                   | Phase 5            |
| P5  | Review and merge the agent's PR yourself on GitHub                                                                                                                                                                  | Phase 5            |
| P6  | Meta developer account + Meta Business portfolio (free), an app with the WhatsApp product, the **test number**, up to 5 verified recipient phones (yours + the admin's), a System User access token, the App Secret | Phase 2b           |
| P8  | Google Cloud account with billing enabled (the $300 new-customer credit), Owner on two new projects, a budget alert; a custom domain if wanted                                                                      | Phase 6            |
| P7  | Public HTTPS URL for the webhook: free ngrok account with its one free static domain (recommended), or a Cloudflare Tunnel if you own a domain on Cloudflare                                                        | Phase 2b           |

---

## 17. Known limitations / honest risks

- AI output is non-deterministic: the demo may need a retry or a clarification round. That is the real behaviour and won't be hidden.
- Self-hosted staging on a Windows PC: the PC must be on during the deploy. Staging is reachable only locally.
- Polling instead of webhooks adds about 1 minute of latency to PR/CI status.
- Running the full integration test suite _inside_ the agent container is constrained (no Docker-in-Docker by design); CI is the authority for integration tests.
- Migration rollback is forward-only unless the PR includes a down migration.

---

## 18. Decision: Option A — public repo `eraqaty/evolvesales` + branch protection

**Rules on `main`:**

- pull request required
- 1 approving review from someone other than the PR author (the bot opens PRs, and you approve them)
- required status check `ci`
- linear history
- no force-push or deletion
- required conversation resolution; stale approvals dismissed on new pushes; the last push must be approved by someone else
- squash merge only; branches deleted after merge
- **Applied 2026-11-19.** Admins (the repo owner) may bypass the rules (`enforce_admins: false`). As the only human maintainer, the owner can't approve their own PRs, so development PRs during Phases 1–5 are merged with the admin bypass. The AI's GitHub App is never an admin, so it can't bypass anything: an agent PR always needs the owner's approval + green CI. Revisit when a second maintainer joins.
- Also applied: secret scanning + push protection, Dependabot alerts, approval required for workflow runs from all external contributors, workflow `GITHUB_TOKEN` read-only by default and not allowed to approve PRs.

**Extra hardening because the repo is public:**

- **The self-hosted staging runner must never run code from a pull request.** `deploy-staging.yml` triggers only on `push` to `main` and `workflow_dispatch`. No workflow with `pull_request`/`pull_request_target` uses `self-hosted`. The repo setting "Require approval for all external contributors" is on for workflow runs. Runner registered with the label `evolvesales-staging`.
- **Nothing secret is committed.** `.env*` (except examples), `*.pem` and seed passwords are git-ignored. gitleaks runs in CI and in the DiffPolicyGate. GitHub secret scanning + push protection are turned on (free for public repos).
- **No secrets in pull_request workflows.** Workflows triggered by fork PRs get no secrets (GitHub default); CI needs none.
- **Issues and PRs from strangers are untrusted.** The Orchestrator only acts on PRs it created itself (matched by branch prefix + bot author + CR id), so outsiders can't trigger agent jobs.

---

## 19. WhatsApp channel (Phase 2b)

### 19.1 Decisions

| Topic      | Decision                                                                                                                                                                                       |
| ---------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| API        | Official **WhatsApp Business Platform: Cloud API** (Meta Graph API). No unofficial WhatsApp Web libraries, because they get numbers banned                                                     |
| Number     | Meta **test number** for development and demo (it can message up to 5 verified phones). A real number can be added later through config only                                                   |
| Users can  | Ask how-to questions, ask **read-only business-data questions** (limited by their role), submit change requests, answer clarification questions, check CR status, receive status notifications |
| Admins can | Receive approval cards, then **Approve (requires a 6-digit approval PIN)**, Reject (with a reason) or Request Clarification; open the full plan in the dashboard through a link                |
| Built in   | Phase 2 (as 2b, right after the web assistant)                                                                                                                                                 |

### 19.2 Architecture

```
Phone ⇄ WhatsApp ⇄ Meta Cloud API ──webhook (HTTPS via tunnel)──▶ api: POST /webhooks/whatsapp
                                                                   │ 1 verify X-Hub-Signature-256 (HMAC, App Secret, raw body)
                                                                   │ 2 store InboundChannelEvent (unique wa message id → idempotent)
                                                                   │ 3 enqueue pg-boss "whatsapp.inbound", return 200 immediately
                                                                   ▼
                     api ChannelWorker → resolve user by verified phone → ConversationEngine
                       (the same engine the web drawer uses: LLM + tools + CR creation + approvals)
                                                                   ▼
                     WhatsAppRenderer → WhatsAppClient → Graph API /{phone-number-id}/messages
                     delivery statuses (sent/delivered/read/failed) come back on the same webhook
```

- **One engine, two channels.** `ConversationEngine` takes channel-neutral input and returns channel-neutral output: text, a question with options, a CR summary card, an approval card, a confirmation.
  - The web renderer shows these as rich UI.
  - The WhatsApp renderer maps them to text (chunked at 4,096 characters), **reply buttons** (max 3 — exactly Approve / Reject / Clarify) and **list messages** (for example, picking a screen or one of several invoices).
- **No screen context on WhatsApp.** The assistant asks which part of the app the request is about and offers a list message built from the shared screen registry. The channel is recorded as `WHATSAPP`.
- **Unknown numbers** get one fixed reply ("This number isn't linked to an EvolveSales account") and **no LLM call** (protects cost and data).
- **Commands:** `menu`, `new` (start a fresh conversation), `status` (my open CRs), `pending` (admins: CRs waiting for approval), `help`.
- **Unsupported content** (voice notes, images, documents) gets the reply "Text only for now." This is listed as a future enhancement.

### 19.3 Identity, linking and approval security

- **Phone linking** _(decision 2026-11-20: the user sends the code; this replaces the authentication-template flow)_:
  1. In the web Profile page, the user enters their number (E.164).
  2. The page shows a 6-digit code (valid 10 minutes, stored hashed) and a `wa.me` link to the bot.
  3. The user sends `LINK 123456` to the bot **from that number**. Meta signs every webhook, so the sender's number is proven.
  4. The phone is marked verified only if the sender matches the number entered and the code matches (5 attempts).
  5. Only verified numbers are recognised; unlinking is possible at any time.
  - Linking needs no authentication template, Meta template approval or per-message cost.
- **Approval PIN:** set in the web Profile (argon2-hashed). 5 wrong attempts lock WhatsApp approvals for 30 minutes and notify the user.
- **Approval flow:**
  1. The admin taps **Approve**.
  2. The bot replies "Enter your approval PIN for CR-0007 (plan v2) within 5 minutes."
  3. The PIN is checked.
  4. The CR transition happens through the same `LifecycleService` (role check, self-approval block, audit with `channel=WHATSAPP`, message id).
- **Tamper-proof buttons.** Each button payload carries `crId + planVersion + action + nonce`, signed with HMAC. It's stored as a `PendingAction` that expires in 24 hours and can be used once. If the plan changed after the card was sent, the tap is refused and a fresh card is sent.
- **Honest caveat:** a PIN typed into WhatsApp stays visible in that phone's chat history. That's acceptable for this MVP. The stronger later option is a **WhatsApp Flow** form with a masked PIN field.
- **Reject** asks for a reason (the next message). **Clarify** asks for the questions, which are delivered to the requester on their channel(s).

### 19.4 Read-only data tools (shared with the web assistant)

- The LLM never writes SQL. It may call only typed service functions, executed **as the asking user** with their roles:
  - `findInvoices(filters)`
  - `getInvoice(number)`
  - `salesSummary(period, groupBy: customer|product|day)`
  - `topCustomers(period, n)`
  - `customerSummary(code)`
  - `myChangeRequests()`
  - `changeRequestStatus(key)`
- Results are capped (max 10 rows) and amounts are formatted in EGP. Every data access is audited (`assistant.data_query`, with the tool and arguments).
- Tool outputs go back to the LLM as **data**, so invoice notes or customer names containing instructions cannot steer it (the same prompt-injection rules as §14).

### 19.5 Notifications

- Per-user preferences: web always; WhatsApp on/off per event type (CR status changes, approval needed, PR created, staging deployed).
- **24-hour rule:** inside the 24 h customer-service window, free-form messages are sent. Outside it, only Meta-approved **templates** can be sent.
- Templates to create: `account_link_code` (authentication), `cr_awaiting_approval`, `cr_status_changed`, `cr_clarification_needed` (utility).
- **Cost note:** replies to user-initiated conversations are free. Template messages sent outside the window (admin alerts, status updates) are billed per message by Meta. On the test number, Meta's test allowances apply.

### 19.6 Data model additions

- `User`:
  - `phoneE164` (unique), `phoneVerifiedAt`
  - `approvalPinHash`, `pinFailedCount`, `pinLockedUntil`
  - `notificationPrefs` Json
- `PhoneVerification` (userId, phone, codeHash, expiresAt, attempts)
- `Conversation.channel` `WEB|WHATSAPP`, `lastInboundAt` (24 h window); `ConversationMessage.externalId`
- `InboundChannelEvent` (waMessageId unique, from, type, payload Json, receivedAt, processedAt, error)
- `OutboundMessage` (waMessageId, userId, kind `text|interactive|template`, template, status, error, sentAt, deliveredAt, readAt)
- `PendingAction` (id, nonce, userId, changeRequestId, planVersion, action, expiresAt, consumedAt)

### 19.7 Configuration (`.env`)

`WHATSAPP_ENABLED`, `WHATSAPP_PHONE_NUMBER_ID`, `WHATSAPP_WABA_ID`, `WHATSAPP_ACCESS_TOKEN`, `WHATSAPP_APP_SECRET`, `WHATSAPP_VERIFY_TOKEN`, `WHATSAPP_GRAPH_VERSION`, `PUBLIC_WEBHOOK_BASE_URL`.

The tunnel forwards **only** `/webhooks/whatsapp` (ngrok traffic policy / Cloudflare ingress rule); the rest of the API stays private. The webhook endpoint has its own rate limit and a 1 MB body limit.

### 19.8 Tests

- **Unit:** signature verification (valid, invalid, missing), payload parsing for each message type, renderer limits (3 buttons, list sizes, chunking), PendingAction signing/expiry/replay, PIN lockout, data-tool RBAC.
- **Integration:** recorded Meta webhook fixtures → full path to a created CR / an approval transition, with the Graph API mocked by nock.
- **Live verification (required for Exit 2b):** real messages on the test number from your phone and the admin phone. Reported only after it has actually happened.

---

## 20. Production environment (Phase 6)

> **Decision: Google Cloud** (see §20.8). §20.1, §20.3 and §20.4 apply unchanged in concept. §20.2 and §20.5 describe the Azure variant, kept as the documented alternative.

### 20.1 Goal: automate everything except 3 human decisions

| Automatic                                                                                                                                                                                      | Human (kept on purpose)                                                                                                                     |
| ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| Build, test, image scan, deploy staging, DB migrations, smoke tests, canary rollout, auto-rollback, scaling, TLS certificates, backups, OS/runtime patching, secret rotation reminders, alerts | 1. Approve the AI's plan · 2. Review/merge the PR · 3. Approve the production release _(one tap: web dashboard, WhatsApp + PIN, or GitHub)_ |

Letting AI-written code reach production with no human at all is **not** recommended. The three decisions take minutes; everything between them runs by itself.

### 20.2 Target architecture

```
Users / WhatsApp (Meta webhook)
        │ HTTPS (managed certificate, custom domain)
        ▼
Azure Container Apps environment (VNet-integrated, per stage: stg / prod)
 ├─ web            (Nginx static React)            scale 1–5 on HTTP
 ├─ api            (NestJS)                        scale 1–10 on HTTP / CPU
 ├─ orchestrator   (NestJS worker)                 scale 1–3 on pg-boss queue depth (KEDA postgres scaler)
 ├─ migrate        Container Apps Job (prisma migrate deploy, run per release)
 └─ agent-runner   Container Apps Job (event-triggered, 1 execution per AI job) ── separate locked subnet
                     NSG: outbound only to the egress-proxy → allowlisted domains
Azure Database for PostgreSQL Flexible Server (private endpoint, PITR backups, zone-redundant in prod)
Azure Key Vault (all secrets) · Managed identities (no passwords in config)
Azure Container Registry (images signed, scanned) · Application Insights + Log Analytics (OpenTelemetry)
GitHub Actions ── OIDC federation ──▶ Azure (no stored cloud credentials)
```

**Why this fits the project best:**

- **Container Apps Jobs** run the agent containers on demand in managed sandboxes. The Orchestrator no longer needs the Docker socket, which removes the biggest local risk.
- The service is **serverless containers**: no VMs to patch, automatic scaling, built-in revisions for blue/green, canary and instant rollback.
- It's the Azure target your original brief asked for, and the same images run locally with Docker Compose.
- A public HTTPS endpoint comes built in, so the WhatsApp webhook needs no ngrok in staging or production.

### 20.3 The automatic release pipeline

1. **Merge to `main`**
   - CI builds the images **once**, tagged with the git SHA.
   - Trivy scan, SBOM and signature, then push to ACR.
2. **Staging**
   - Run the `migrate` job.
   - Deploy a new revision.
   - Run the Playwright smoke suite against it.
   - Mark the CR → `STAGING` → `PRODUCTION_APPROVAL`, and notify the ReleaseManager (web + WhatsApp).
3. **Release approval** (ReleaseManager, with PIN on WhatsApp) triggers `deploy-production` through the GitHub `production` environment. The agent's App can't trigger this.
4. **Production canary**
   - Run the `migrate` job (expand-only migrations).
   - Deploy the new revision with **0 % traffic**, then smoke-test its private revision URL.
   - Shift traffic 10 % → 50 % → 100 %, waiting 5 minutes at each step while watching the App Insights error rate and p95 latency.
5. **Auto-rollback.** If an alert fires during or up to 30 minutes after the rollout, traffic switches back to the previous revision in seconds. The CR is marked `FAILED` with the reason, and everyone is notified.
6. **Done.** The CR goes to `RELEASED`, the requester gets a WhatsApp message saying their change is live, and a GitHub release + changelog are created.

**Database safety:** use the **expand → contract** migration rule. Add columns and tables first; remove old ones only in a later release. That way an app rollback never needs a database rollback. The PlanVerifier and DiffPolicyGate flag destructive migrations for explicit approval.

### 20.4 Operations that run by themselves

- **Backups:** Postgres point-in-time restore (7 days staging, 35 days production), plus geo-redundant backup in production. A monthly automated restore test into a scratch server.
- **Scaling:** HTTP and queue-based scaling, with min 1 replica for api/web in production (no cold starts).
- **Security:**
  - Dependabot, CodeQL (free for public repos), secret scanning, weekly image rebuilds for base-image patches
  - Key Vault secret-expiry alerts
  - Defender for Cloud (optional, adds cost)
- **Monitoring:** OpenTelemetry traces across web → api → orchestrator → agent job. Availability tests every 5 minutes. Alerts go to email + the admin's WhatsApp.
- **Cost guardrails:** an Azure budget with alerts at 50/80/100 %, plus the AI spend caps you configure.
- **Infrastructure as Code:** Bicep under `infra/`, deployed by the pipeline. The agent can never change it (DiffPolicyGate blocks `infra/**`).

### 20.5 Rough monthly cost (small company, low traffic, before AI usage)

| Item                                                                    | Staging     | Production   |
| ----------------------------------------------------------------------- | ----------- | ------------ |
| Container Apps (consumption + jobs)                                     | ~$10–25     | ~$30–80      |
| PostgreSQL Flexible (B1ms stg / B2s prod, zone-redundant prod adds ~2×) | ~$15        | ~$35–80      |
| ACR Basic, Key Vault, Log Analytics / App Insights                      | ~$10        | ~$15–40      |
| **Total (estimate, verify with the Azure pricing calculator)**          | **~$35–50** | **~$80–200** |

Strict FQDN egress filtering through **Azure Firewall** costs far more (hundreds of dollars a month). The plan uses an NSG + egress-proxy container instead. That's cheaper, but it relies on the proxy for domain filtering.

### 20.6 Alternatives considered

| Option                                          | Fits when                                 | Main drawback                                                                             |
| ----------------------------------------------- | ----------------------------------------- | ----------------------------------------------------------------------------------------- |
| **Azure Container Apps (recommended)**          | You want managed, automatic, Azure-native | Azure lock-in for the runner jobs                                                         |
| Single VM + Docker Compose (Azure VM / Hetzner) | Lowest cost (~$20–40/month all-in)        | You patch the OS, there's no automatic rollback or scaling, and a single point of failure |
| AKS / Kubernetes                                | Many apps, platform team                  | Too much to operate for one app                                                           |
| Supabase (DB) + Container Apps                  | You prefer Supabase tooling               | Weaker private networking; still fine                                                     |

### 20.7 Free option for testing production (before paying for Azure)

_Free-tier limits change often. Re-check each provider's current terms before signing up._

**Key constraint:** EvolveSales needs (1) an always-on worker and (2) the ability to start isolated containers on demand for the AI agent. Most free PaaS tiers (Render, Vercel, Netlify, Cloudflare Workers) can't do either. They sleep, have no background workers, or can't launch containers. So the free setup must include a real VM, or Azure's free grants.

**Recommended free stack: "Free-Prod"**

| Piece                                                      | Free service                                                                                                                               | Notes                                                                                                                                                                                                                                                                                                     |
| ---------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Server (api, orchestrator, agent containers, egress proxy) | **Oracle Cloud Always Free**: Ampere ARM VM, up to 4 OCPU / 24 GB RAM                                                                      | Runs the same Docker Compose stack with the same agent isolation. Images built for **arm64** too. Needs a card at signup (not charged); free capacity in some regions can be hard to get; idle Always-Free VMs may be reclaimed                                                                           |
| Database                                                   | **Supabase Free** (500 MB)                                                                                                                 | Use the **session pooler** connection (port 5432). pg-boss needs session features, so not the transaction pooler (6543). The free project pauses after ~7 days without activity, and there's no point-in-time restore. Alternative: Postgres on the VM, with a nightly `pg_dump` uploaded to free storage |
| Web frontend                                               | **Cloudflare Pages** (static React)                                                                                                        | Free, global CDN, preview deployment per PR                                                                                                                                                                                                                                                               |
| HTTPS for API + WhatsApp webhook                           | **Cloudflare Tunnel** (needs a domain on Cloudflare, about $10/yr) **or** Caddy + Let's Encrypt on the VM with a free `*.duckdns.org` name | No open inbound ports with the Tunnel                                                                                                                                                                                                                                                                     |
| CI/CD                                                      | **GitHub Actions** (free for public repos) + **GHCR** image registry (free for public)                                                     | Deploy over SSH to the VM, so **no self-hosted runner on your PC** is needed                                                                                                                                                                                                                              |
| Errors / uptime                                            | Sentry free tier, UptimeRobot or Better Stack free monitors                                                                                | Alerts by email                                                                                                                                                                                                                                                                                           |
| WhatsApp                                                   | Meta test number                                                                                                                           | Free                                                                                                                                                                                                                                                                                                      |
| AI                                                         | Anthropic / OpenAI API                                                                                                                     | **Not free.** You pay per use, controlled by your spend caps                                                                                                                                                                                                                                              |

Expected cost: **$0** (about $10/year if you buy a domain), plus AI usage.

**Alternative: Azure free account.** It's the closest match to the final production design (§20.2), so there's nothing to redo later.

- New accounts get a 30-day credit plus 12 months of selected services, including PostgreSQL Flexible B1ms.
- Container Apps has a monthly free grant. It covers scale-to-zero services and agent jobs at demo scale. **Correction:** always-on replicas (orchestrator, api with min 1) will probably exceed it, so expect a small monthly cost (roughly $5–20) after the first-month credit.
- Use GHCR instead of ACR to avoid the registry fee.
- Risk: costs start when the 12 months end, or if the grants are exceeded. Set a budget alert of $1 on day one.

**Alternative: Google Cloud.**

| Piece                   | Google service                                                                             | Free?                                                          |
| ----------------------- | ------------------------------------------------------------------------------------------ | -------------------------------------------------------------- |
| api, web                | **Cloud Run** (scale to zero)                                                              | Monthly always-free allowance (requests, vCPU-seconds, memory) |
| AI agent containers     | **Cloud Run Jobs**, one execution per job, gVisor sandbox (strong isolation)               | Same allowance                                                 |
| Always-on orchestrator  | **e2-micro VM** (1 GB RAM, US regions only)                                                | Always free; tight but enough for a Node worker                |
| Database                | Cloud SQL has **no** free tier → use **Supabase Free** (or Cloud SQL paid with the credit) | Supabase free                                                  |
| Images / secrets / logs | Artifact Registry (small free amount) or GHCR, Secret Manager, Cloud Logging               | Free at this scale                                             |
| New-account credit      | $300 for 90 days                                                                           | —                                                              |

Google's credit is bigger and lasts longer than Azure's, and Cloud Run Jobs isolate the agent well. The trade-off: the database isn't free on Google after the credit, and your original brief named Azure.

**Portability.** Whichever cloud is chosen, the code uses an `AgentJobLauncher` interface with three implementations: `DockerLauncher` (local / VM), `AzureContainerAppsJobLauncher` and `CloudRunJobLauncher`. Switching clouds later means changing config and infrastructure files, not the application.

### 20.8 Chosen design: Google Cloud

```
Users / WhatsApp webhook ──HTTPS (Google-managed cert)──▶ Cloud Run: web (nginx) + api (NestJS), scale 0–N
                                                           │ pg-boss jobs
Supabase Free Postgres (session pooler) ◀──────────────────┤  (one project for stg, one for prod)
                                                           ▼
e2-micro VM (Always Free, us-central1): orchestrator (Docker Compose, auto-restart) + egress proxy (squid)
        │ Cloud Run Admin API (service account: run.jobs.run only)
        ▼
Cloud Run Job: agent-runner (gVisor sandbox, 2 vCPU / 4 GiB, 45-min timeout, 1 task per execution)
        Direct VPC egress (all traffic) → firewall: deny all egress except the proxy VM:3128 → allowlisted domains
GitHub Actions ──Workload Identity Federation──▶ Artifact Registry / GHCR → Cloud Run deploys
```

| §20.1/20.3 concept        | Google implementation                                                                                                                                             |
| ------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Canary + instant rollback | Cloud Run **revisions + traffic splitting**. New revision deployed with `--no-traffic` and a tag URL for smoke tests, then 10 → 50 → 100 %                        |
| Auto-rollback trigger     | Cloud Monitoring alert (5xx rate, p95 latency) checked by the release workflow between steps; on breach, traffic goes back to the previous revision               |
| DB migrations             | Cloud Run Job `migrate` executed by the pipeline before traffic shifts (expand → contract rule)                                                                   |
| Secrets                   | Secret Manager, mounted into Cloud Run; orchestrator VM reads them with its service account. Agent jobs get only per-run secrets (read-only GitHub token, AI key) |
| Monitoring                | Cloud Logging, Error Reporting, uptime checks + alerting (email); WhatsApp alerts through our notifications service                                               |
| Infrastructure as Code    | **Terraform** in `infra/` (replaces Bicep); DiffPolicyGate blocks `infra/**`                                                                                      |
| Region                    | `us-central1` (required for the Always Free e2-micro); about 150 ms from Egypt, fine for this app                                                                 |

**Costs and things to verify before Phase 6:**

- Within the 90-day $300 credit: effectively $0.
- After the credit: Cloud Run and Cloud Run Jobs stay inside the free allowance at demo scale; the e2-micro is free; Supabase is free.
- **Possible small charges to verify:** the VM's external IPv4 address, VPC egress traffic, and Artifact Registry storage beyond the free amount (GHCR avoids that last one).
- A budget alert at $1 is created by Terraform on day one.

**Known free-tier trade-offs:**

- The e2-micro has 1 GB RAM: only the orchestrator and the proxy run there (no builds).
- Supabase Free pauses inactive projects (staging may pause; production stays busy), has no point-in-time restore (nightly `pg_dump` to a Cloud Storage bucket is added), and has a 500 MB limit.
- Cloud Run scaled to zero means the first request after idle takes a few seconds; `min-instances=1` on production api removes that but costs money.

### Comparison of the options considered (kept for reference)

The facts: `MasterVisionSoft` is on GitHub Free. Free accounts can't enforce branch protection on **private** repos. The GitHub App permission "Contents: write" covers every branch, including `main`.

| Option                              | Cost | Private? | What actually stops the AI from changing `main`                                                                                                      |
| ----------------------------------- | ---- | -------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| A. Public repo + branch protection  | Free | No       | GitHub rules: PR + green CI + 1 human approval required                                                                                              |
| B. Two repos ("fork model")         | Free | Yes      | The AI's credentials can write only to a separate copy repo. On the real repo they can only open a PR, so GitHub rejects any push or merge to `main` |
| C. One private repo, app-only check | Free | Yes      | Only our Orchestrator code refuses to push `main`; GitHub doesn't enforce anything                                                                   |
| D. Upgrade the org to GitHub Team   | Paid | Yes      | Same as A                                                                                                                                            |

Option B requires turning on "Allow forking of private repositories" in the org settings (currently off). With B, the deploy-staging workflow also checks that each merged commit came from a PR with green CI and an approving review. This replaces the "required checks" rule that the free plan can't enforce.
