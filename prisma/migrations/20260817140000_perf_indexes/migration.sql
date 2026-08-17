CREATE INDEX "Profile_email_idx" ON "Profile"("email");
CREATE INDEX "Service_profileId_status_idx" ON "Service"("profileId", "status");
CREATE INDEX "EventLog_profileId_eventType_createdAt_idx"
  ON "EventLog"("profileId", "eventType", "createdAt");
CREATE INDEX "CustomTab_profileId_isEnabled_isPublic_sortOrder_idx"
  ON "CustomTab"("profileId", "isEnabled", "isPublic", "sortOrder");
CREATE INDEX "CustomTabItem_customTabId_sortOrder_idx"
  ON "CustomTabItem"("customTabId", "sortOrder");

CREATE INDEX "Faq_profile_public_sort"
  ON "Faq"("profileId", "sortOrder")
  WHERE "deletedAt" IS NULL AND "status" = '1';
CREATE INDEX "Gallery_profile_public_sort"
  ON "Gallery"("profileId", "sortOrder")
  WHERE "deletedAt" IS NULL AND "status" = '1';
CREATE INDEX "Video_profile_public_sort"
  ON "Video"("profileId", "sortOrder")
  WHERE "deletedAt" IS NULL AND "status" = '1';
