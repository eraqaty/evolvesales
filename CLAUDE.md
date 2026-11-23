@AGENTS.md

# EvolveSales — start here (Claude Code sessions)

AI-powered, self-evolving sales-invoice app (pnpm monorepo: NestJS API + Orchestrator, React web,
Prisma/PostgreSQL, pg-boss, Docker agent containers). Built phase by phase from an approved plan.

**Read in this order:**

1. [AGENTS.md](AGENTS.md): code conventions and commands (loaded above).
2. [HANDOFF.md](HANDOFF.md): **current state, open PR, next steps, what is outside the repository**.
3. [README.md](README.md): setup, run, test, business rules.
4. [docs/IMPLEMENTATION_PLAN.md](docs/IMPLEMENTATION_PLAN.md): architecture, security design, phases, and every decision taken ("Phase N decisions" and "implementation notes"). It is the source of truth.
5. Setup guides: [docs/GITHUB_APP_SETUP.md](docs/GITHUB_APP_SETUP.md) (Phase 3) and [docs/WHATSAPP_SETUP.md](docs/WHATSAPP_SETUP.md) (Phase 2b).

## Ground rules from the owner (non-negotiable)

- **Do not pre-implement Export to Excel.** It must arrive through the administrator-approved AI coding workflow: it is the Phase 5 live demo.
- Never simulate repository operations, coding results or deployments. Never claim success without verification; report what was not verified.
- Never expose production database credentials to the coding agent. Agent containers get no database credentials at all.
- Never push to `main`. Work on a `phase-N/<topic>` branch and open a PR; the owner reviews and merges.
- Approval of a plan authorizes the coding phase only, never production deployment.
- Secrets (API keys, tokens, `.pem`, `.env` values) are set by the owner. Don't read `.env` values and never write secrets into files, commits or chat. The repository is **public**.

## Working agreements

- **Plan first.** Before each phase, present a detailed plan plus all open questions (plain language, with a recommended option), and wait for explicit approval. Record every decision in `docs/IMPLEMENTATION_PLAN.md`.
- After a phase: run `pnpm verify` and `pnpm test:e2e`, commit, push the branch, and open the PR only when the owner says so. Update [HANDOFF.md](HANDOFF.md).
- Git identity for this repository: GitHub account `eraqaty` through `gh`, with a noreply email (setup in HANDOFF.md §6). Don't change the global git config.
- Windows notes for this PC:
  - Write commit messages and PR bodies to a file (`git commit -F file`, `gh pr create --body-file file`).
  - Don't rewrite files through Windows PowerShell 5.1 `Get-Content`/`Set-Content`, which corrupts UTF-8.
  - Avoid regex escapes passed through shell or `node -e` strings; use an editor tool.
  - Known flaky-under-load symptoms are listed in HANDOFF.md §4.
