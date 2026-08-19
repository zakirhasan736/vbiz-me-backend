-- Corporate per-account package feature overrides (inherit when no row).
CREATE TABLE "CorporateFeatureOverride" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "featureKey" TEXT NOT NULL,
    "featureValue" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CorporateFeatureOverride_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "CorporateFeatureOverride_userId_featureKey_key" ON "CorporateFeatureOverride"("userId", "featureKey");

CREATE INDEX "CorporateFeatureOverride_userId_idx" ON "CorporateFeatureOverride"("userId");

ALTER TABLE "CorporateFeatureOverride" ADD CONSTRAINT "CorporateFeatureOverride_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
