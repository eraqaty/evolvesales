# GitHub App and repository analysis setup (Phase 3)

The repository analysis agent reads `eraqaty/evolvesales` through a **GitHub App**. The App's
private key stays with the Orchestrator. Each analysis job gets a token that:

- lasts about 1 hour;
- covers one repository only;
- is **read-only** (`contents: read`).

The agent runs in a single-use, locked-down container, and its only way out is an allowlist proxy.

You do the steps marked **you**, because they create credentials or change your GitHub account.
Allow about 15 minutes.

## 1. Create the App (you)

1. GitHub → your avatar → **Settings** → **Developer settings** → **GitHub Apps** → **New GitHub App**.
2. Fill in:
   - **GitHub App name:** `EvolveSales Agent` (it must be unique on GitHub; add a suffix if taken).
   - **Homepage URL:** `https://github.com/eraqaty/evolvesales`.
   - **Webhook:** untick **Active**. The MVP polls GitHub, because GitHub can't reach `localhost`.
3. **Repository permissions.** Set these now, so you don't have to approve a change later. Each job
   still narrows its own token to what it needs; analysis uses only **Contents: read**.

   | Permission      | Access         | Used by                                              |
   | --------------- | -------------- | ---------------------------------------------------- |
   | Contents        | Read and write | analysis reads (Phase 3); pushing branches (Phase 4) |
   | Pull requests   | Read and write | opening the agent's PR (Phase 4)                     |
   | Checks          | Read-only      | CI status (Phase 4)                                  |
   | Actions         | Read-only      | workflow runs (Phase 5)                              |
   | Commit statuses | Read-only      | CI status (Phase 4)                                  |
   | Deployments     | Read-only      | staging deploys (Phase 5)                            |
   | Metadata        | Read-only      | required by GitHub                                   |

   Leave every **Organization** and **Account** permission at _No access_.

4. **Where can this GitHub App be installed?** → **Only on this account**.
5. **Create GitHub App**. On the next page, note the **App ID** (a number).

## 2. Private key (you)

1. On the App's page → **Private keys** → **Generate a private key**. A `.pem` file downloads.
2. Move it **outside the repository**, for example `C:\Users\<you>\.evolvesales\github-app.pem`.
   - `.gitignore` and `.dockerignore` both exclude `*.pem`, but keeping the file outside the
     repository is the safer habit.
   - Never paste the key into `.env`, chat or an issue.
3. Anyone holding this file can act as the App on the repositories it is installed on. If it ever
   leaks, delete it on the App page and generate a new one.

## 3. Install the App on the repository (you)

App page → **Install App** → your account → **Only select repositories** → `eraqaty/evolvesales` →
**Install**.

## 4. Configure the Orchestrator (you, in `.env`)

```dotenv
GITHUB_APP_ID=123456
GITHUB_APP_PRIVATE_KEY_PATH=C:\Users\<you>\.evolvesales\github-app.pem
ANTHROPIC_API_KEY=...            # ideally a dedicated key with a spend limit
AGENT_RUNNER_IMAGE=evolvesales/agent-runner:local
AGENT_DOCKER_HOST=tcp://127.0.0.1:2375
```

At start-up, the Orchestrator refuses a key file that isn't a PEM private key. It never prints the
key.

## 5. Start the agent infrastructure

```bash
pnpm agents:up
```

```bash
pnpm runner:build
```

- `agents:up` starts two containers:
  - **egress-proxy**: the agent containers' only way out. It allows HTTPS to github.com, the Anthropic
    API and the other hosts in §9 of the plan, and nothing else.
  - **docker-socket-proxy**: the Orchestrator's restricted view of Docker. It allows only the calls
    the launcher needs; `exec`, file copy and the like are refused.
- `runner:build` builds `evolvesales/agent-runner:local`. The first build downloads about 180 MB
  for the Agent SDK.

Then restart the Orchestrator:

```bash
pnpm dev:orchestrator
```

Within a minute it lists the App's repositories.

## 6. Authorize the repository and set the spend caps (you, in the web app)

Sign in as `admin@evolvesales.local` → **Agents** (left menu):

1. **Spend caps:** set the per-job cap and the daily cap in USD.
   - There are no defaults: analysis refuses to start until both are set.
   - A job starts only if today's spend (UTC) plus the per-job cap stays within the daily cap.
2. **Repositories:**
   - Press **Refresh from GitHub** if the list is empty.
   - **Authorize** `eraqaty/evolvesales`. Only one repository can be authorized at a time.

## 7. Try it (Exit 3)

1. Sign in as `sales@evolvesales.local` and submit a small change request, for example "add a
   tooltip to the Confirm button".
2. Open the request → **Timeline** → **Log: ANALYZE job** to watch the agent live.
3. When it finishes, the request is **Awaiting approval** (or **Clarification required** if the
   agent asked questions). The **Plan** tab shows:
   - the baseline commit;
   - each affected file, marked as _verified_ (with the exact cited lines) or _unverified_;
   - findings the PlanVerifier downgraded to assumptions.
4. Check that the container is gone. This should print nothing:

```bash
docker ps -a --filter label=evolvesales.role=agent-runner
```

## How it is kept safe

| Concern                                                | Control                                                                                                                                                                       |
| ------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Agent changes code or runs commands                    | Tools limited to Read/Grep/Glob; Bash, Write, Edit, web and subagents removed; every call also passes a path guard; checkout is read-only and `.git` and symlinks are deleted |
| Agent reads outside the repository                     | The path guard resolves symlinks and denies anything outside `/workspace/repo` (no `/proc`, no home directory)                                                                |
| Instructions hidden in repository files or the request | Treated as data by the system prompt; repository settings, `CLAUDE.md`, hooks and MCP servers are not loaded; the plan is checked afterwards                                  |
| Invented findings                                      | The PlanVerifier checks every cited excerpt against GitHub at the baseline commit and downgrades what doesn't match                                                           |
| Secrets                                                | GitHub token and AI key go in on stdin only: not in env, labels or `docker inspect`; the token is deleted after the clone; log lines are scanned for credential patterns      |
| Network                                                | Internal-only Docker network; HTTPS to allowlisted hosts through the egress proxy; IP literals and other ports refused                                                        |
| Runaway cost or time                                   | Per-job and daily USD caps (admin-set); max 40 turns; 15-minute wall clock; 2 CPUs, 4 GB RAM, 512 processes                                                                   |
| Database                                               | The container gets no database credentials of any kind                                                                                                                        |
| Leftover containers                                    | Always removed after the job; orphans are reaped when the Orchestrator starts                                                                                                 |
