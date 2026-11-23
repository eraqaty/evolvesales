-- Phase 3: repository analysis (GitHub repositories, agent spend caps, job logs). Additive only.

-- CreateEnum
CREATE TYPE "JobLogLevel" AS ENUM ('INFO', 'WARN', 'ERROR');

-- AlterTable
ALTER TABLE "agent_jobs" ADD COLUMN     "budget_usd" DECIMAL(10,2);

-- AlterTable
ALTER TABLE "change_requests" ADD COLUMN     "repository_id" UUID;

-- CreateTable
CREATE TABLE "job_logs" (
    "id" BIGSERIAL NOT NULL,
    "agent_job_id" UUID NOT NULL,
    "seq" INTEGER NOT NULL,
    "level" "JobLogLevel" NOT NULL DEFAULT 'INFO',
    "source" TEXT NOT NULL,
    "message" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "job_logs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "repositories" (
    "id" UUID NOT NULL,
    "github_id" BIGINT NOT NULL,
    "full_name" TEXT NOT NULL,
    "installation_id" BIGINT NOT NULL,
    "default_branch" TEXT NOT NULL,
    "is_private" BOOLEAN NOT NULL DEFAULT false,
    "is_authorized" BOOLEAN NOT NULL DEFAULT false,
    "authorized_by_id" UUID,
    "authorized_at" TIMESTAMPTZ(3),
    "removed_at" TIMESTAMPTZ(3),
    "last_synced_at" TIMESTAMPTZ(3) NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "repositories_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "agent_settings" (
    "id" INTEGER NOT NULL DEFAULT 1,
    "analyze_max_budget_usd" DECIMAL(10,2),
    "daily_budget_usd" DECIMAL(10,2),
    "updated_by_id" UUID,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "agent_settings_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "job_logs_agent_job_id_seq_key" ON "job_logs"("agent_job_id", "seq");

-- CreateIndex
CREATE UNIQUE INDEX "repositories_github_id_key" ON "repositories"("github_id");

-- CreateIndex
CREATE UNIQUE INDEX "repositories_full_name_key" ON "repositories"("full_name");

-- CreateIndex
CREATE INDEX "agent_jobs_started_at_idx" ON "agent_jobs"("started_at");

-- AddForeignKey
ALTER TABLE "change_requests" ADD CONSTRAINT "change_requests_repository_id_fkey" FOREIGN KEY ("repository_id") REFERENCES "repositories"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "job_logs" ADD CONSTRAINT "job_logs_agent_job_id_fkey" FOREIGN KEY ("agent_job_id") REFERENCES "agent_jobs"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "repositories" ADD CONSTRAINT "repositories_authorized_by_id_fkey" FOREIGN KEY ("authorized_by_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "agent_settings" ADD CONSTRAINT "agent_settings_updated_by_id_fkey" FOREIGN KEY ("updated_by_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;


-- Hand-written constraints
ALTER TABLE "agent_settings" ADD CONSTRAINT "agent_settings_singleton" CHECK ("id" = 1);
ALTER TABLE "agent_settings" ADD CONSTRAINT "agent_settings_budgets_positive"
  CHECK (("analyze_max_budget_usd" IS NULL OR "analyze_max_budget_usd" > 0)
     AND ("daily_budget_usd" IS NULL OR "daily_budget_usd" > 0));
ALTER TABLE "repositories" ADD CONSTRAINT "repositories_full_name_format"
  CHECK ("full_name" ~ '^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$');
ALTER TABLE "job_logs" ADD CONSTRAINT "job_logs_seq_nonnegative" CHECK ("seq" >= 0);
CREATE INDEX "change_requests_repository_id_idx" ON "change_requests"("repository_id");
