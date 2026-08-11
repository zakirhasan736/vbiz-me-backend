-- AlterTable
ALTER TABLE "Profile" ADD COLUMN IF NOT EXISTS "isDraft" BOOLEAN NOT NULL DEFAULT false;

-- CreateIndex
CREATE INDEX IF NOT EXISTS "Profile_isDraft_idx" ON "Profile"("isDraft");
