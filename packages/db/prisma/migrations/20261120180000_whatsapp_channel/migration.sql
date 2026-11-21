-- CreateEnum
CREATE TYPE "OutboundKind" AS ENUM ('TEXT', 'INTERACTIVE', 'TEMPLATE');

-- CreateEnum
CREATE TYPE "OutboundStatus" AS ENUM ('PENDING', 'SENT', 'DELIVERED', 'READ', 'FAILED');

-- CreateEnum
CREATE TYPE "PendingActionStage" AS ENUM ('CARD', 'AWAITING_PIN', 'AWAITING_REASON', 'AWAITING_QUESTIONS');

-- AlterTable
ALTER TABLE "conversation_messages" ADD COLUMN     "external_id" TEXT;

-- AlterTable
ALTER TABLE "notifications" ADD COLUMN     "whatsapp_handled_at" TIMESTAMPTZ(3);

-- AlterTable
ALTER TABLE "users" ADD COLUMN     "approval_pin_hash" TEXT,
ADD COLUMN     "notification_prefs" JSONB,
ADD COLUMN     "phone_e164" TEXT,
ADD COLUMN     "phone_verified_at" TIMESTAMPTZ(3),
ADD COLUMN     "pin_failed_count" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "pin_locked_until" TIMESTAMPTZ(3),
ADD COLUMN     "whatsapp_last_inbound_at" TIMESTAMPTZ(3);

-- CreateTable
CREATE TABLE "phone_verifications" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "phone_e164" TEXT NOT NULL,
    "code_hash" TEXT NOT NULL,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "expires_at" TIMESTAMPTZ(3) NOT NULL,
    "consumed_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "phone_verifications_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "inbound_channel_events" (
    "id" UUID NOT NULL,
    "wa_message_id" TEXT NOT NULL,
    "from_phone" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "received_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "processed_at" TIMESTAMPTZ(3),
    "error" TEXT,

    CONSTRAINT "inbound_channel_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "outbound_messages" (
    "id" UUID NOT NULL,
    "wa_message_id" TEXT,
    "user_id" UUID,
    "to_phone" TEXT NOT NULL,
    "kind" "OutboundKind" NOT NULL,
    "template" TEXT,
    "summary" TEXT NOT NULL,
    "notification_id" UUID,
    "status" "OutboundStatus" NOT NULL DEFAULT 'PENDING',
    "error" TEXT,
    "sent_at" TIMESTAMPTZ(3),
    "delivered_at" TIMESTAMPTZ(3),
    "read_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "outbound_messages_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "pending_actions" (
    "id" UUID NOT NULL,
    "nonce" TEXT NOT NULL,
    "user_id" UUID NOT NULL,
    "change_request_id" UUID NOT NULL,
    "plan_version" INTEGER NOT NULL,
    "action" TEXT,
    "stage" "PendingActionStage" NOT NULL DEFAULT 'CARD',
    "stage_expires_at" TIMESTAMPTZ(3),
    "expires_at" TIMESTAMPTZ(3) NOT NULL,
    "consumed_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "pending_actions_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "phone_verifications_phone_e164_idx" ON "phone_verifications"("phone_e164");

-- CreateIndex
CREATE INDEX "phone_verifications_user_id_idx" ON "phone_verifications"("user_id");

-- CreateIndex
CREATE UNIQUE INDEX "inbound_channel_events_wa_message_id_key" ON "inbound_channel_events"("wa_message_id");

-- CreateIndex
CREATE UNIQUE INDEX "outbound_messages_wa_message_id_key" ON "outbound_messages"("wa_message_id");

-- CreateIndex
CREATE INDEX "outbound_messages_user_id_created_at_idx" ON "outbound_messages"("user_id", "created_at");

-- CreateIndex
CREATE INDEX "pending_actions_user_id_stage_idx" ON "pending_actions"("user_id", "stage");

-- CreateIndex
CREATE UNIQUE INDEX "conversation_messages_external_id_key" ON "conversation_messages"("external_id");

-- CreateIndex
CREATE UNIQUE INDEX "users_phone_e164_key" ON "users"("phone_e164");

-- AddForeignKey
ALTER TABLE "phone_verifications" ADD CONSTRAINT "phone_verifications_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "outbound_messages" ADD CONSTRAINT "outbound_messages_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "pending_actions" ADD CONSTRAINT "pending_actions_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;


-- ── Hand-written additions ──

-- Only E.164 numbers (+ and 8-15 digits) can be stored.
ALTER TABLE "users" ADD CONSTRAINT "users_phone_e164_format"
  CHECK ("phone_e164" IS NULL OR "phone_e164" ~ '^\+[1-9][0-9]{7,14}$');
ALTER TABLE "phone_verifications" ADD CONSTRAINT "phone_verifications_phone_e164_format"
  CHECK ("phone_e164" ~ '^\+[1-9][0-9]{7,14}$');
ALTER TABLE "users" ADD CONSTRAINT "users_pin_failed_count_nonneg" CHECK ("pin_failed_count" >= 0);
ALTER TABLE "pending_actions" ADD CONSTRAINT "pending_actions_action_valid"
  CHECK ("action" IS NULL OR "action" IN ('approve', 'reject', 'clarify'));
