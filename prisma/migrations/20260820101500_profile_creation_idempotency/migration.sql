ALTER TABLE "Profile" ADD COLUMN "creationKey" TEXT;

CREATE UNIQUE INDEX "Profile_creationKey_key" ON "Profile"("creationKey");
