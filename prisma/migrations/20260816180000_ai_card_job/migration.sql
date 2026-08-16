-- AlterTable
ALTER TABLE "AiGenerationLog" ADD COLUMN IF NOT EXISTS "jobId" TEXT;
ALTER TABLE "AiGenerationLog" ADD COLUMN IF NOT EXISTS "stage" TEXT;
ALTER TABLE "AiGenerationLog" ADD COLUMN IF NOT EXISTS "cachedInputTokens" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "AiGenerationLog" ADD COLUMN IF NOT EXISTS "retryNumber" INTEGER NOT NULL DEFAULT 0;

-- AlterTable
ALTER TABLE "AiCardSession" ADD COLUMN IF NOT EXISTS "profileId" TEXT;
ALTER TABLE "AiCardSession" ADD COLUMN IF NOT EXISTS "status" TEXT NOT NULL DEFAULT 'QUEUED';
ALTER TABLE "AiCardSession" ADD COLUMN IF NOT EXISTS "architecture" JSONB;
ALTER TABLE "AiCardSession" ADD COLUMN IF NOT EXISTS "selectedNavIds" JSONB;
ALTER TABLE "AiCardSession" ADD COLUMN IF NOT EXISTS "fieldGraph" JSONB;
ALTER TABLE "AiCardSession" ADD COLUMN IF NOT EXISTS "fieldDecisions" JSONB;
ALTER TABLE "AiCardSession" ADD COLUMN IF NOT EXISTS "assembledDraft" JSONB;
ALTER TABLE "AiCardSession" ADD COLUMN IF NOT EXISTS "userProgress" JSONB;
ALTER TABLE "AiCardSession" ADD COLUMN IF NOT EXISTS "errorMessage" TEXT;
ALTER TABLE "AiCardSession" ADD COLUMN IF NOT EXISTS "architectureVersion" INTEGER NOT NULL DEFAULT 1;

CREATE INDEX IF NOT EXISTS "AiGenerationLog_jobId_idx" ON "AiGenerationLog"("jobId");
CREATE INDEX IF NOT EXISTS "AiCardSession_profileId_idx" ON "AiCardSession"("profileId");
CREATE INDEX IF NOT EXISTS "AiCardSession_status_idx" ON "AiCardSession"("status");
