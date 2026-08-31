-- Personal address: city and state on Profile (street + zip already on Profile / Address)
ALTER TABLE "Profile" ADD COLUMN IF NOT EXISTS "city" TEXT;
ALTER TABLE "Profile" ADD COLUMN IF NOT EXISTS "state" TEXT;
