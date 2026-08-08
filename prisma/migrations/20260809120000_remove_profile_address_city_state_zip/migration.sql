-- Remove personal address city/state/zip fields (keep street address on Profile.address / Address.line1)
ALTER TABLE "Profile" DROP COLUMN IF EXISTS "zipCode";
ALTER TABLE "Address" DROP COLUMN IF EXISTS "city";
ALTER TABLE "Address" DROP COLUMN IF EXISTS "state";
ALTER TABLE "Address" DROP COLUMN IF EXISTS "zipCode";
