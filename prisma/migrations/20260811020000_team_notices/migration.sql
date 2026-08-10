-- CreateTable
CREATE TABLE "TeamNotice" (
    "id" TEXT NOT NULL,
    "ownerId" TEXT NOT NULL,
    "text" TEXT NOT NULL,
    "type" TEXT NOT NULL DEFAULT 'broadcast',
    "audience" TEXT NOT NULL DEFAULT 'all',
    "targetProfileId" TEXT,
    "recipientCount" INTEGER,
    "status" TEXT NOT NULL DEFAULT 'active',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "TeamNotice_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "TeamNotice_ownerId_createdAt_idx" ON "TeamNotice"("ownerId", "createdAt");

-- CreateIndex
CREATE INDEX "TeamNotice_status_audience_idx" ON "TeamNotice"("status", "audience");

-- CreateIndex
CREATE INDEX "TeamNotice_targetProfileId_idx" ON "TeamNotice"("targetProfileId");

-- AddForeignKey
ALTER TABLE "TeamNotice" ADD CONSTRAINT "TeamNotice_ownerId_fkey" FOREIGN KEY ("ownerId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
