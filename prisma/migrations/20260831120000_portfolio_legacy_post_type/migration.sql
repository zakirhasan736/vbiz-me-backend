ALTER TABLE "Portfolio"
ADD COLUMN IF NOT EXISTS "legacyPostTypeId" INTEGER NOT NULL DEFAULT 4;

UPDATE "Portfolio"
SET "legacyPostTypeId" = 4
WHERE "legacyPostTypeId" IS NULL;
