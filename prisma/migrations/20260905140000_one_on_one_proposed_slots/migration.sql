-- AlterTable
ALTER TABLE "OneOnOneRequest" ADD COLUMN IF NOT EXISTS "proposedTitle" TEXT;
ALTER TABLE "OneOnOneRequest" ADD COLUMN IF NOT EXISTS "proposedDescription" TEXT;
ALTER TABLE "OneOnOneRequest" ADD COLUMN IF NOT EXISTS "proposedTimezone" TEXT;
ALTER TABLE "OneOnOneRequest" ADD COLUMN IF NOT EXISTS "proposedDurationMinutes" INTEGER;

-- CreateTable
CREATE TABLE IF NOT EXISTS "OneOnOneProposedSlot" (
    "id" TEXT NOT NULL,
    "requestId" TEXT NOT NULL,
    "date" TEXT NOT NULL,
    "startTime" TEXT NOT NULL,
    "durationMinutes" INTEGER NOT NULL DEFAULT 30,
    "timezone" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'available',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "OneOnOneProposedSlot_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX IF NOT EXISTS "OneOnOneProposedSlot_requestId_status_idx" ON "OneOnOneProposedSlot"("requestId", "status");

-- AddForeignKey
DO $$ BEGIN
  ALTER TABLE "OneOnOneProposedSlot" ADD CONSTRAINT "OneOnOneProposedSlot_requestId_fkey"
    FOREIGN KEY ("requestId") REFERENCES "OneOnOneRequest"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;
