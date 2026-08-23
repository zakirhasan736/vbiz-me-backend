-- Persist package → back-office mode so callers do not hardcode slug === 'corporate'.
CREATE TYPE "PackageOwnerMode" AS ENUM ('single', 'corporate');

ALTER TABLE "Package" ADD COLUMN "ownerMode" "PackageOwnerMode" NOT NULL DEFAULT 'single';

UPDATE "Package"
SET "ownerMode" = 'corporate'
WHERE lower(coalesce("slug", '')) IN ('corporate', 'corporate-starter')
   OR lower(coalesce("slug", '')) LIKE 'corporate%'
   OR lower(coalesce("name", '')) LIKE '%corporate%';
