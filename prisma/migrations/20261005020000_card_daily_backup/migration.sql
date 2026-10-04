-- Daily per-card backups. The app keeps the newest 7 days and deletes the oldest.

CREATE TABLE "CardDailyBackup" (
    "id" TEXT NOT NULL,
    "profileId" TEXT NOT NULL,
    "backupDate" TEXT NOT NULL,
    "tabCount" INTEGER NOT NULL,
    "tabs" JSONB NOT NULL,
    "snapshot" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CardDailyBackup_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "CardDailyBackup_profileId_backupDate_key" ON "CardDailyBackup"("profileId", "backupDate");
CREATE INDEX "CardDailyBackup_profileId_backupDate_idx" ON "CardDailyBackup"("profileId", "backupDate");
CREATE INDEX "CardDailyBackup_backupDate_idx" ON "CardDailyBackup"("backupDate");

ALTER TABLE "CardDailyBackup" ADD CONSTRAINT "CardDailyBackup_profileId_fkey" FOREIGN KEY ("profileId") REFERENCES "Profile"("id") ON DELETE CASCADE ON UPDATE CASCADE;
