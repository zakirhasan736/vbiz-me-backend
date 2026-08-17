-- List/dashboard query support: filter by profile + status/time, then order.
CREATE INDEX IF NOT EXISTS "Portfolio_profileId_status_idx" ON "Portfolio"("profileId", "status");
CREATE INDEX IF NOT EXISTS "Review_profileId_status_idx" ON "Review"("profileId", "status");
CREATE INDEX IF NOT EXISTS "Post_profileId_status_idx" ON "Post"("profileId", "status");
CREATE INDEX IF NOT EXISTS "Contact_profileId_createdAt_idx" ON "Contact"("profileId", "createdAt");
CREATE INDEX IF NOT EXISTS "GuestUserData_profileId_createdAt_idx" ON "GuestUserData"("profileId", "createdAt");
CREATE INDEX IF NOT EXISTS "UserNote_profileId_createdAt_idx" ON "UserNote"("profileId", "createdAt");
