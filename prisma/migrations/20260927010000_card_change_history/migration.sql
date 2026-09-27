-- CreateTable
CREATE TABLE "CardChangeHistory" (
    "id" TEXT NOT NULL,
    "profileId" TEXT NOT NULL,
    "area" TEXT NOT NULL,
    "areaLabel" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "summary" TEXT NOT NULL,
    "actorId" TEXT,
    "actorName" TEXT NOT NULL,
    "actorRoleLabel" TEXT NOT NULL,
    "device" TEXT,
    "location" TEXT,
    "userAgent" TEXT,
    "snapshot" JSONB,
    "snapshotExpiresAt" TIMESTAMP(3),
    "restoredAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CardChangeHistory_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "CardChangeHistory_profileId_createdAt_idx" ON "CardChangeHistory"("profileId", "createdAt");

-- CreateIndex
CREATE INDEX "CardChangeHistory_snapshotExpiresAt_idx" ON "CardChangeHistory"("snapshotExpiresAt");

-- AddForeignKey
ALTER TABLE "CardChangeHistory" ADD CONSTRAINT "CardChangeHistory_profileId_fkey" FOREIGN KEY ("profileId") REFERENCES "Profile"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CardChangeHistory" ADD CONSTRAINT "CardChangeHistory_actorId_fkey" FOREIGN KEY ("actorId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
