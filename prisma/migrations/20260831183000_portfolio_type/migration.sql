ALTER TABLE "Portfolio"
ADD COLUMN IF NOT EXISTS "type" TEXT NOT NULL DEFAULT 'Image';

ALTER TABLE "Gallery"
ADD COLUMN IF NOT EXISTS "type" TEXT NOT NULL DEFAULT 'Image';

UPDATE "Portfolio"
SET "type" =
  CASE
    WHEN "legacyPostTypeId" = 5 THEN 'Video'
    ELSE 'Image'
  END;

UPDATE "Gallery"
SET "type" =
  CASE
    WHEN "legacyPostTypeId" = 5 THEN 'Video'
    ELSE 'Image'
  END;
