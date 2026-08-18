-- Preserve Client rows; only add the Laravel service mapping used for media repair.
ALTER TABLE "Client" ADD COLUMN IF NOT EXISTS "legacyServiceId" INTEGER;
CREATE UNIQUE INDEX IF NOT EXISTS "Client_legacyServiceId_key" ON "Client"("legacyServiceId");
