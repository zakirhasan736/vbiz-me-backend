-- CreateTable
CREATE TABLE "MediaAsset" (
    "id" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "profileId" TEXT,
    "area" TEXT,
    "itemLabel" TEXT,
    "uploadedById" TEXT,
    "originalName" TEXT,
    "contentType" TEXT,
    "bytes" INTEGER,
    "source" TEXT NOT NULL DEFAULT 'upload',
    "checkedAt" TIMESTAMP(3),
    "missingReason" TEXT,
    "recoveredAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "MediaAsset_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "MediaAsset_key_key" ON "MediaAsset"("key");

-- CreateIndex
CREATE INDEX "MediaAsset_profileId_status_idx" ON "MediaAsset"("profileId", "status");

-- CreateIndex
CREATE INDEX "MediaAsset_status_idx" ON "MediaAsset"("status");
