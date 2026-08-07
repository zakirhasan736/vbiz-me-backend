-- AlterTable
ALTER TABLE "GuestUserData" ADD COLUMN IF NOT EXISTS "fullName" TEXT;
ALTER TABLE "GuestUserData" ADD COLUMN IF NOT EXISTS "phone" TEXT;
ALTER TABLE "GuestUserData" ADD COLUMN IF NOT EXISTS "meta" JSONB;

-- Backfill fullName from legacy first/last name where possible
UPDATE "GuestUserData"
SET "fullName" = NULLIF(
  TRIM(
    CONCAT(
      COALESCE("firstName", ''),
      CASE
        WHEN COALESCE("lastName", '') = '' THEN ''
        ELSE CONCAT(' ', "lastName")
      END
    )
  ),
  ''
)
WHERE "fullName" IS NULL
  AND (
    COALESCE("firstName", '') <> ''
    OR COALESCE("lastName", '') <> ''
  );
