-- AlterTable
ALTER TABLE "PushNotificationPreference" ADD COLUMN IF NOT EXISTS "eventUpdates" BOOLEAN NOT NULL DEFAULT true;
ALTER TABLE "PushNotificationPreference" ADD COLUMN IF NOT EXISTS "announcementUpdates" BOOLEAN NOT NULL DEFAULT true;

-- Deduplicate (profileId, endpointHash) before unique constraint: keep newest active row
DELETE FROM "PushSubscription" a
USING "PushSubscription" b
WHERE a."profileId" = b."profileId"
  AND a."endpointHash" = b."endpointHash"
  AND a."id" < b."id";

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "PushSubscription_profileId_endpointHash_key" ON "PushSubscription"("profileId", "endpointHash");
