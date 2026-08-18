ALTER TABLE "Review"
ADD COLUMN IF NOT EXISTS "legacyServiceId" INTEGER;

CREATE INDEX IF NOT EXISTS "Review_legacyServiceId_idx"
ON "Review"("legacyServiceId");
