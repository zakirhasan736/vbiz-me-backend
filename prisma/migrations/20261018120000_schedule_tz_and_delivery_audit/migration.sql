-- AlterTable
ALTER TABLE "Meeting" ADD COLUMN IF NOT EXISTS "timezone" TEXT NOT NULL DEFAULT 'America/New_York';

-- AlterTable
ALTER TABLE "CrmEvent" ADD COLUMN IF NOT EXISTS "timezone" TEXT NOT NULL DEFAULT 'America/New_York';

-- CreateTable
CREATE TABLE IF NOT EXISTS "NotificationDeliveryAttempt" (
    "id" TEXT NOT NULL,
    "eventKey" TEXT NOT NULL,
    "channel" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "profileId" TEXT,
    "recipientRole" TEXT,
    "recipientRef" TEXT,
    "relatedRecordId" TEXT,
    "error" TEXT,
    "meta" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "NotificationDeliveryAttempt_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX IF NOT EXISTS "NotificationDeliveryAttempt_eventKey_idx" ON "NotificationDeliveryAttempt"("eventKey");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "NotificationDeliveryAttempt_channel_status_idx" ON "NotificationDeliveryAttempt"("channel", "status");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "NotificationDeliveryAttempt_profileId_createdAt_idx" ON "NotificationDeliveryAttempt"("profileId", "createdAt");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "NotificationDeliveryAttempt_createdAt_idx" ON "NotificationDeliveryAttempt"("createdAt");
