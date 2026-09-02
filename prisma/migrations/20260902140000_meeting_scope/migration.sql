-- Meeting scope: global (all owners), group (selected cards), one_to_one (single card).
ALTER TABLE "Meeting" ADD COLUMN IF NOT EXISTS "scope" TEXT NOT NULL DEFAULT 'one_to_one';
ALTER TABLE "Meeting" ADD COLUMN IF NOT EXISTS "groupProfileIds" JSONB;

-- Existing rows with a profile are one-to-one; rows without are treated as global.
UPDATE "Meeting" SET "scope" = 'one_to_one' WHERE "profileId" IS NOT NULL AND "scope" = 'one_to_one';
UPDATE "Meeting" SET "scope" = 'global' WHERE "profileId" IS NULL;

CREATE INDEX IF NOT EXISTS "Meeting_scope_idx" ON "Meeting"("scope");
