-- CreateTable
CREATE TABLE "CanvaEditSession" (
    "id" TEXT NOT NULL,
    "correlationState" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "profileId" TEXT NOT NULL,
    "fieldKey" TEXT NOT NULL,
    "itemKey" TEXT,
    "attachmentType" TEXT,
    "designId" TEXT NOT NULL,
    "designTitle" TEXT,
    "mediaKind" TEXT NOT NULL DEFAULT 'image',
    "exportFormat" TEXT NOT NULL DEFAULT 'png',
    "targetWidth" INTEGER,
    "targetHeight" INTEGER,
    "builderRoute" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'awaiting_return',
    "exportJobId" TEXT,
    "resultUrl" TEXT,
    "resultFilename" TEXT,
    "resultMime" TEXT,
    "attachmentId" TEXT,
    "errorMessage" TEXT,
    "correlationJti" TEXT,
    "canvaUserId" TEXT,
    "canvaTeamId" TEXT,
    "importStartedAt" TIMESTAMP(3),
    "completedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CanvaEditSession_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "CanvaEditSession_correlationState_key" ON "CanvaEditSession"("correlationState");

-- CreateIndex
CREATE UNIQUE INDEX "CanvaEditSession_correlationJti_key" ON "CanvaEditSession"("correlationJti");

-- CreateIndex
CREATE INDEX "CanvaEditSession_userId_idx" ON "CanvaEditSession"("userId");

-- CreateIndex
CREATE INDEX "CanvaEditSession_profileId_idx" ON "CanvaEditSession"("profileId");

-- CreateIndex
CREATE INDEX "CanvaEditSession_designId_idx" ON "CanvaEditSession"("designId");

-- CreateIndex
CREATE INDEX "CanvaEditSession_status_idx" ON "CanvaEditSession"("status");

-- CreateIndex
CREATE INDEX "CanvaEditSession_expiresAt_idx" ON "CanvaEditSession"("expiresAt");

-- AddForeignKey
ALTER TABLE "CanvaEditSession" ADD CONSTRAINT "CanvaEditSession_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
