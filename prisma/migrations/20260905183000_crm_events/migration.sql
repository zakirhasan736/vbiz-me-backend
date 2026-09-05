-- CreateTable
CREATE TABLE "CrmEvent" (
    "id" TEXT NOT NULL,
    "host" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "date" TEXT NOT NULL,
    "time" TEXT NOT NULL,
    "startsAt" TIMESTAMP(3) NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'Scheduled',
    "scope" TEXT NOT NULL DEFAULT 'one_to_one',
    "profileId" TEXT,
    "groupProfileIds" JSONB,
    "attachments" JSONB,
    "createdById" TEXT,
    "googleEventId" TEXT,
    "meetLink" TEXT,
    "reminderSentAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CrmEvent_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "CrmEvent_status_idx" ON "CrmEvent"("status");

-- CreateIndex
CREATE INDEX "CrmEvent_startsAt_idx" ON "CrmEvent"("startsAt");

-- CreateIndex
CREATE INDEX "CrmEvent_profileId_idx" ON "CrmEvent"("profileId");

-- CreateIndex
CREATE INDEX "CrmEvent_type_idx" ON "CrmEvent"("type");

-- CreateIndex
CREATE INDEX "CrmEvent_scope_idx" ON "CrmEvent"("scope");

-- CreateIndex
CREATE INDEX "CrmEvent_reminderSentAt_startsAt_idx" ON "CrmEvent"("reminderSentAt", "startsAt");

-- AddForeignKey
ALTER TABLE "CrmEvent" ADD CONSTRAINT "CrmEvent_profileId_fkey" FOREIGN KEY ("profileId") REFERENCES "Profile"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CrmEvent" ADD CONSTRAINT "CrmEvent_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
