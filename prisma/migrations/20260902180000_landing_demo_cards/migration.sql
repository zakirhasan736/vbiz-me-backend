-- CreateTable
CREATE TABLE "LandingDemoCard" (
    "id" TEXT NOT NULL,
    "category" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "designationOverride" TEXT,
    "profileId" TEXT,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "status" TEXT NOT NULL DEFAULT 'active',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "LandingDemoCard_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "LandingDemoCard_slug_key" ON "LandingDemoCard"("slug");

-- CreateIndex
CREATE INDEX "LandingDemoCard_status_sortOrder_idx" ON "LandingDemoCard"("status", "sortOrder");

-- CreateIndex
CREATE INDEX "LandingDemoCard_profileId_idx" ON "LandingDemoCard"("profileId");

-- AddForeignKey
ALTER TABLE "LandingDemoCard" ADD CONSTRAINT "LandingDemoCard_profileId_fkey" FOREIGN KEY ("profileId") REFERENCES "Profile"("id") ON DELETE SET NULL ON UPDATE CASCADE;
