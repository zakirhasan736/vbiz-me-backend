-- CreateTable
CREATE TABLE "AiGenerationLog" (
    "id" TEXT NOT NULL,
    "userId" TEXT,
    "profileId" TEXT,
    "sessionId" TEXT,
    "task" TEXT NOT NULL,
    "model" TEXT NOT NULL,
    "tier" TEXT NOT NULL,
    "inputTokens" INTEGER NOT NULL DEFAULT 0,
    "outputTokens" INTEGER NOT NULL DEFAULT 0,
    "estimatedCost" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "latencyMs" INTEGER NOT NULL DEFAULT 0,
    "success" BOOLEAN NOT NULL DEFAULT true,
    "escalatedFrom" TEXT,
    "error" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AiGenerationLog_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AiCardSession" (
    "id" TEXT NOT NULL,
    "userId" TEXT,
    "websiteUrl" TEXT,
    "sourceHash" TEXT,
    "rawSources" JSONB,
    "normalizedSources" JSONB,
    "businessProfile" JSONB,
    "generatedContent" JSONB,
    "finalBlueprint" JSONB,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AiCardSession_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "AiGenerationLog_userId_idx" ON "AiGenerationLog"("userId");

-- CreateIndex
CREATE INDEX "AiGenerationLog_profileId_idx" ON "AiGenerationLog"("profileId");

-- CreateIndex
CREATE INDEX "AiGenerationLog_sessionId_idx" ON "AiGenerationLog"("sessionId");

-- CreateIndex
CREATE INDEX "AiGenerationLog_tier_idx" ON "AiGenerationLog"("tier");

-- CreateIndex
CREATE INDEX "AiGenerationLog_createdAt_idx" ON "AiGenerationLog"("createdAt");

-- CreateIndex
CREATE INDEX "AiCardSession_userId_idx" ON "AiCardSession"("userId");

-- CreateIndex
CREATE INDEX "AiCardSession_sourceHash_idx" ON "AiCardSession"("sourceHash");

-- CreateIndex
CREATE INDEX "AiCardSession_expiresAt_idx" ON "AiCardSession"("expiresAt");

-- AddForeignKey
ALTER TABLE "AiGenerationLog" ADD CONSTRAINT "AiGenerationLog_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AiGenerationLog" ADD CONSTRAINT "AiGenerationLog_profileId_fkey" FOREIGN KEY ("profileId") REFERENCES "Profile"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AiCardSession" ADD CONSTRAINT "AiCardSession_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
