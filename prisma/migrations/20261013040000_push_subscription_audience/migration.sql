-- Split Web Push recipients: public-card followers vs backoffice card owners.
ALTER TABLE "PushSubscription"
ADD COLUMN IF NOT EXISTS "audience" TEXT NOT NULL DEFAULT 'follower';

CREATE INDEX IF NOT EXISTS "PushSubscription_profileId_audience_idx"
ON "PushSubscription"("profileId", "audience");
