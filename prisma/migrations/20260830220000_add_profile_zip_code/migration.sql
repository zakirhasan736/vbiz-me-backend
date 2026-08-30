-- Restore zip code on profile personal address (and primary Address row)
ALTER TABLE "Profile" ADD COLUMN IF NOT EXISTS "zipCode" TEXT;
ALTER TABLE "Address" ADD COLUMN IF NOT EXISTS "zipCode" TEXT;
