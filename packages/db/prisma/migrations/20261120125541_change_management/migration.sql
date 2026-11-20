-- CreateEnum
CREATE TYPE "CrStatus" AS ENUM ('SUBMITTED', 'ANALYZING', 'AWAITING_APPROVAL', 'CLARIFICATION_REQUIRED', 'APPROVED', 'REJECTED', 'CODING', 'TESTING', 'PULL_REQUEST_CREATED', 'REVIEW', 'STAGING', 'PRODUCTION_APPROVAL', 'RELEASED', 'FAILED');

-- CreateEnum
CREATE TYPE "CrPriority" AS ENUM ('LOW', 'MEDIUM', 'HIGH');

-- CreateEnum
CREATE TYPE "ConversationStatus" AS ENUM ('OPEN', 'SUBMITTED', 'CLOSED');

-- CreateEnum
CREATE TYPE "Channel" AS ENUM ('WEB', 'WHATSAPP');

-- CreateEnum
CREATE TYPE "MessageRole" AS ENUM ('user', 'assistant', 'system');

-- CreateEnum
CREATE TYPE "ApprovalDecisionKind" AS ENUM ('APPROVED', 'REJECTED', 'CLARIFICATION');

-- CreateEnum
CREATE TYPE "ActorType" AS ENUM ('USER', 'SYSTEM');

-- CreateEnum
CREATE TYPE "AgentJobType" AS ENUM ('ANALYZE', 'CODE');

-- CreateEnum
CREATE TYPE "AgentJobStatus" AS ENUM ('QUEUED', 'RUNNING', 'SUCCEEDED', 'FAILED', 'TIMED_OUT', 'CANCELLED');

-- CreateTable
CREATE TABLE "change_requests" (
    "id" UUID NOT NULL,
    "key" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "requester_id" UUID NOT NULL,
    "screen" TEXT NOT NULL,
    "screen_context" JSONB,
    "original_request" TEXT NOT NULL,
    "structured" JSONB NOT NULL,
    "status" "CrStatus" NOT NULL,
    "priority" "CrPriority" NOT NULL DEFAULT 'MEDIUM',
    "pending_questions" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "baseline_sha" TEXT,
    "branch_name" TEXT,
    "current_plan_id" UUID,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "change_requests_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "conversations" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "change_request_id" UUID,
    "channel" "Channel" NOT NULL DEFAULT 'WEB',
    "screen" TEXT NOT NULL,
    "screen_context" JSONB,
    "status" "ConversationStatus" NOT NULL DEFAULT 'OPEN',
    "proposal" JSONB,
    "pending_clarification" JSONB,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "conversations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "conversation_messages" (
    "id" UUID NOT NULL,
    "conversation_id" UUID NOT NULL,
    "role" "MessageRole" NOT NULL,
    "content" TEXT NOT NULL,
    "metadata" JSONB,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "conversation_messages_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "implementation_plans" (
    "id" UUID NOT NULL,
    "change_request_id" UUID NOT NULL,
    "version" INTEGER NOT NULL,
    "baseline_sha" TEXT,
    "plan" JSONB NOT NULL,
    "verified_count" INTEGER NOT NULL DEFAULT 0,
    "assumption_count" INTEGER NOT NULL DEFAULT 0,
    "agent" TEXT,
    "model" TEXT,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "implementation_plans_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "approval_decisions" (
    "id" UUID NOT NULL,
    "change_request_id" UUID NOT NULL,
    "plan_id" UUID,
    "decision" "ApprovalDecisionKind" NOT NULL,
    "actor_id" UUID NOT NULL,
    "comment" TEXT,
    "override_reason" TEXT,
    "channel" "Channel" NOT NULL DEFAULT 'WEB',
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "approval_decisions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "status_transitions" (
    "id" UUID NOT NULL,
    "change_request_id" UUID NOT NULL,
    "from" "CrStatus",
    "to" "CrStatus" NOT NULL,
    "actor_type" "ActorType" NOT NULL,
    "actor_id" UUID,
    "reason" TEXT,
    "metadata" JSONB,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "status_transitions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "agent_jobs" (
    "id" UUID NOT NULL,
    "change_request_id" UUID NOT NULL,
    "type" "AgentJobType" NOT NULL,
    "status" "AgentJobStatus" NOT NULL DEFAULT 'QUEUED',
    "queue_job_id" TEXT,
    "agent_kind" TEXT,
    "model" TEXT,
    "container_id" TEXT,
    "image_digest" TEXT,
    "started_at" TIMESTAMPTZ(3),
    "finished_at" TIMESTAMPTZ(3),
    "exit_code" INTEGER,
    "input_tokens" INTEGER,
    "output_tokens" INTEGER,
    "cost_usd" DECIMAL(10,4),
    "error" TEXT,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "agent_jobs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "notifications" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "type" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "link" TEXT,
    "read_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "notifications_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "change_requests_key_key" ON "change_requests"("key");

-- CreateIndex
CREATE UNIQUE INDEX "change_requests_current_plan_id_key" ON "change_requests"("current_plan_id");

-- CreateIndex
CREATE INDEX "change_requests_status_idx" ON "change_requests"("status");

-- CreateIndex
CREATE INDEX "change_requests_requester_id_idx" ON "change_requests"("requester_id");

-- CreateIndex
CREATE INDEX "conversations_user_id_idx" ON "conversations"("user_id");

-- CreateIndex
CREATE INDEX "conversations_change_request_id_idx" ON "conversations"("change_request_id");

-- CreateIndex
CREATE INDEX "conversation_messages_conversation_id_created_at_idx" ON "conversation_messages"("conversation_id", "created_at");

-- CreateIndex
CREATE UNIQUE INDEX "implementation_plans_change_request_id_version_key" ON "implementation_plans"("change_request_id", "version");

-- CreateIndex
CREATE INDEX "approval_decisions_change_request_id_idx" ON "approval_decisions"("change_request_id");

-- CreateIndex
CREATE INDEX "status_transitions_change_request_id_created_at_idx" ON "status_transitions"("change_request_id", "created_at");

-- CreateIndex
CREATE INDEX "agent_jobs_change_request_id_idx" ON "agent_jobs"("change_request_id");

-- CreateIndex
CREATE INDEX "agent_jobs_status_idx" ON "agent_jobs"("status");

-- CreateIndex
CREATE INDEX "notifications_user_id_read_at_idx" ON "notifications"("user_id", "read_at");

-- AddForeignKey
ALTER TABLE "change_requests" ADD CONSTRAINT "change_requests_requester_id_fkey" FOREIGN KEY ("requester_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "change_requests" ADD CONSTRAINT "change_requests_current_plan_id_fkey" FOREIGN KEY ("current_plan_id") REFERENCES "implementation_plans"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "conversations" ADD CONSTRAINT "conversations_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "conversations" ADD CONSTRAINT "conversations_change_request_id_fkey" FOREIGN KEY ("change_request_id") REFERENCES "change_requests"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "conversation_messages" ADD CONSTRAINT "conversation_messages_conversation_id_fkey" FOREIGN KEY ("conversation_id") REFERENCES "conversations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "implementation_plans" ADD CONSTRAINT "implementation_plans_change_request_id_fkey" FOREIGN KEY ("change_request_id") REFERENCES "change_requests"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "approval_decisions" ADD CONSTRAINT "approval_decisions_change_request_id_fkey" FOREIGN KEY ("change_request_id") REFERENCES "change_requests"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "approval_decisions" ADD CONSTRAINT "approval_decisions_plan_id_fkey" FOREIGN KEY ("plan_id") REFERENCES "implementation_plans"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "approval_decisions" ADD CONSTRAINT "approval_decisions_actor_id_fkey" FOREIGN KEY ("actor_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "status_transitions" ADD CONSTRAINT "status_transitions_change_request_id_fkey" FOREIGN KEY ("change_request_id") REFERENCES "change_requests"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "status_transitions" ADD CONSTRAINT "status_transitions_actor_id_fkey" FOREIGN KEY ("actor_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "agent_jobs" ADD CONSTRAINT "agent_jobs_change_request_id_fkey" FOREIGN KEY ("change_request_id") REFERENCES "change_requests"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ───────────── Hand-written additions ─────────────

-- Human-readable CR keys (CR-0001); nextval is gap-tolerant and race-free.
CREATE SEQUENCE "change_request_key_seq" START 1;

-- Lifecycle history is append-only, like audit_logs.
CREATE FUNCTION "reject_history_mutation"() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION '% is append-only (% rejected)', TG_TABLE_NAME, TG_OP
    USING ERRCODE = 'insufficient_privilege';
END;
$$;

CREATE TRIGGER "status_transitions_no_update"
  BEFORE UPDATE ON "status_transitions"
  FOR EACH ROW EXECUTE FUNCTION "reject_history_mutation"();

CREATE TRIGGER "status_transitions_no_delete"
  BEFORE DELETE ON "status_transitions"
  FOR EACH ROW EXECUTE FUNCTION "reject_history_mutation"();

-- Approval decisions are history too.
CREATE TRIGGER "approval_decisions_no_update"
  BEFORE UPDATE ON "approval_decisions"
  FOR EACH ROW EXECUTE FUNCTION "reject_history_mutation"();

CREATE TRIGGER "approval_decisions_no_delete"
  BEFORE DELETE ON "approval_decisions"
  FOR EACH ROW EXECUTE FUNCTION "reject_history_mutation"();

ALTER TABLE "change_requests"
  ADD CONSTRAINT "change_requests_key_format" CHECK ("key" ~ '^CR-[0-9]{4,}$');

ALTER TABLE "approval_decisions"
  ADD CONSTRAINT "approval_decisions_comment_required"
  CHECK ("decision" = 'APPROVED' OR length(btrim(coalesce("comment", ''))) > 0);

ALTER TABLE "implementation_plans"
  ADD CONSTRAINT "implementation_plans_version_positive" CHECK ("version" >= 1);