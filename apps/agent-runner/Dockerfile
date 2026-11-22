# EvolveSales agent-runner (§9). Build from the repository root:
#   pnpm runner:build
# The Orchestrator runs it read-only, as uid 10001, with all capabilities dropped, on the
# internal agent network only; secrets arrive on stdin. See apps/orchestrator/src/agent.

ARG NODE_IMAGE=node:22-bookworm-slim@sha256:e9f565d32859f0cbfb52125eafe8be39390f24dac302dc3cdf566e8ba3ab21ee

FROM ${NODE_IMAGE} AS build
WORKDIR /src
RUN corepack enable
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./
COPY packages/shared/package.json packages/shared/
COPY apps/agent-runner/package.json apps/agent-runner/
RUN pnpm install --frozen-lockfile --filter "@evolvesales/agent-runner..." --filter "."
COPY packages/shared packages/shared
COPY apps/agent-runner apps/agent-runner
RUN pnpm --filter @evolvesales/shared build && pnpm --filter @evolvesales/agent-runner build

# Production dependencies only, in a clean tree.
FROM ${NODE_IMAGE} AS deps
WORKDIR /app
RUN corepack enable
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY packages/shared/package.json packages/shared/
COPY apps/agent-runner/package.json apps/agent-runner/
RUN pnpm install --frozen-lockfile --prod --filter "@evolvesales/agent-runner..."
COPY --from=build /src/packages/shared/dist packages/shared/dist
COPY --from=build /src/apps/agent-runner/dist apps/agent-runner/dist

FROM ${NODE_IMAGE}
RUN apt-get update \
  && apt-get install -y --no-install-recommends git ca-certificates \
  && rm -rf /var/lib/apt/lists/* \
  && groupadd --gid 10001 agent \
  && useradd --uid 10001 --gid 10001 --home-dir /home/agent --shell /usr/sbin/nologin agent \
  && mkdir -p /workspace /home/agent \
  && chown agent:agent /workspace /home/agent
COPY --from=deps /app /app
ENV NODE_ENV=production
USER 10001:10001
WORKDIR /workspace
ENTRYPOINT ["node", "/app/apps/agent-runner/dist/main.js"]
