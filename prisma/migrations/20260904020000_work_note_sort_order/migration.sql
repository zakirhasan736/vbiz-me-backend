-- AlterTable
ALTER TABLE "WorkNote" ADD COLUMN IF NOT EXISTS "sortOrder" INTEGER NOT NULL DEFAULT 0;

-- CreateIndex
CREATE INDEX IF NOT EXISTS "WorkNote_status_sortOrder_idx" ON "WorkNote"("status", "sortOrder");
