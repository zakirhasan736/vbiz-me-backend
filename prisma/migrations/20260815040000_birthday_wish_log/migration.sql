-- CreateTable
CREATE TABLE "BirthdayWishLog" (
    "id" TEXT NOT NULL,
    "profileId" TEXT NOT NULL,
    "year" INTEGER NOT NULL,
    "sentAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "BirthdayWishLog_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "BirthdayWishLog_year_idx" ON "BirthdayWishLog"("year");

-- CreateIndex
CREATE UNIQUE INDEX "BirthdayWishLog_profileId_year_key" ON "BirthdayWishLog"("profileId", "year");

-- AddForeignKey
ALTER TABLE "BirthdayWishLog" ADD CONSTRAINT "BirthdayWishLog_profileId_fkey" FOREIGN KEY ("profileId") REFERENCES "Profile"("id") ON DELETE CASCADE ON UPDATE CASCADE;
