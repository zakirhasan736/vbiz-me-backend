-- Repair singleton unique indexes required by Prisma upsert / one-row-per-card.
-- Some environments created WhyChooseUs/AboutMe without WhyChooseUs_profileId_key
-- (or duplicates blocked the unique index), which causes Postgres 42P10 on upsert.

-- WhyChooseUs: keep the newest row per profileId, drop older duplicates
DELETE FROM "WhyChooseUs" w
USING "WhyChooseUs" newer
WHERE w."profileId" = newer."profileId"
  AND (
    w."updatedAt" < newer."updatedAt"
    OR (w."updatedAt" = newer."updatedAt" AND w."id" < newer."id")
  );

CREATE UNIQUE INDEX IF NOT EXISTS "WhyChooseUs_profileId_key" ON "WhyChooseUs"("profileId");
CREATE UNIQUE INDEX IF NOT EXISTS "WhyChooseUs_legacyPostId_key" ON "WhyChooseUs"("legacyPostId");
CREATE INDEX IF NOT EXISTS "WhyChooseUs_profileId_idx" ON "WhyChooseUs"("profileId");

-- AboutMe: same singleton contract
DELETE FROM "AboutMe" a
USING "AboutMe" newer
WHERE a."profileId" = newer."profileId"
  AND (
    a."updatedAt" < newer."updatedAt"
    OR (a."updatedAt" = newer."updatedAt" AND a."id" < newer."id")
  );

CREATE UNIQUE INDEX IF NOT EXISTS "AboutMe_profileId_key" ON "AboutMe"("profileId");
CREATE UNIQUE INDEX IF NOT EXISTS "AboutMe_legacyPostId_key" ON "AboutMe"("legacyPostId");
CREATE INDEX IF NOT EXISTS "AboutMe_profileId_idx" ON "AboutMe"("profileId");
