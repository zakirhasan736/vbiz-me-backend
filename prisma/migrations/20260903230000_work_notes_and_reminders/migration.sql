-- AlterTable
ALTER TABLE "Meeting" ADD COLUMN IF NOT EXISTS "reminderSentAt" TIMESTAMP(3);

-- CreateIndex
CREATE INDEX IF NOT EXISTS "Meeting_reminderSentAt_startsAt_idx" ON "Meeting"("reminderSentAt", "startsAt");

-- CreateTable
CREATE TABLE IF NOT EXISTS "WorkNote" (
    "id" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "description" TEXT,
    "status" TEXT NOT NULL DEFAULT 'not_started',
    "assigneeUserId" TEXT,
    "createdById" TEXT NOT NULL,
    "profileId" TEXT,
    "leadRef" TEXT,
    "startsAt" TIMESTAMP(3),
    "dueAt" TIMESTAMP(3),
    "remindAt" TIMESTAMP(3),
    "reminderSentAt" TIMESTAMP(3),
    "ownerUserId" TEXT,
    "companyUserId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "WorkNote_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX IF NOT EXISTS "WorkNote_status_idx" ON "WorkNote"("status");
CREATE INDEX IF NOT EXISTS "WorkNote_assigneeUserId_idx" ON "WorkNote"("assigneeUserId");
CREATE INDEX IF NOT EXISTS "WorkNote_createdById_idx" ON "WorkNote"("createdById");
CREATE INDEX IF NOT EXISTS "WorkNote_profileId_idx" ON "WorkNote"("profileId");
CREATE INDEX IF NOT EXISTS "WorkNote_ownerUserId_idx" ON "WorkNote"("ownerUserId");
CREATE INDEX IF NOT EXISTS "WorkNote_companyUserId_idx" ON "WorkNote"("companyUserId");
CREATE INDEX IF NOT EXISTS "WorkNote_dueAt_idx" ON "WorkNote"("dueAt");
CREATE INDEX IF NOT EXISTS "WorkNote_remindAt_reminderSentAt_idx" ON "WorkNote"("remindAt", "reminderSentAt");

-- AddForeignKey
DO $$ BEGIN
  ALTER TABLE "WorkNote" ADD CONSTRAINT "WorkNote_assigneeUserId_fkey" FOREIGN KEY ("assigneeUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE "WorkNote" ADD CONSTRAINT "WorkNote_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE "WorkNote" ADD CONSTRAINT "WorkNote_profileId_fkey" FOREIGN KEY ("profileId") REFERENCES "Profile"("id") ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
