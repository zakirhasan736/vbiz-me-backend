-- Idempotent: this migration previously failed on production when CustomTab/Faq/Gallery/Video
-- were not present yet. CREATE INDEX IF NOT EXISTS + table guards so it can be re-applied.
CREATE INDEX IF NOT EXISTS "Profile_email_idx" ON "Profile"("email");
CREATE INDEX IF NOT EXISTS "Service_profileId_status_idx" ON "Service"("profileId", "status");
CREATE INDEX IF NOT EXISTS "EventLog_profileId_eventType_createdAt_idx"
  ON "EventLog"("profileId", "eventType", "createdAt");

DO $$
BEGIN
  IF to_regclass('public."CustomTab"') IS NOT NULL THEN
    EXECUTE 'CREATE INDEX IF NOT EXISTS "CustomTab_profileId_isEnabled_isPublic_sortOrder_idx" ON "CustomTab"("profileId", "isEnabled", "isPublic", "sortOrder")';
  END IF;

  IF to_regclass('public."CustomTabItem"') IS NOT NULL THEN
    EXECUTE 'CREATE INDEX IF NOT EXISTS "CustomTabItem_customTabId_sortOrder_idx" ON "CustomTabItem"("customTabId", "sortOrder")';
  END IF;

  IF to_regclass('public."Faq"') IS NOT NULL THEN
    EXECUTE $idx$
      CREATE INDEX IF NOT EXISTS "Faq_profile_public_sort"
      ON "Faq"("profileId", "sortOrder")
      WHERE "deletedAt" IS NULL AND "status" = '1'
    $idx$;
  END IF;

  IF to_regclass('public."Gallery"') IS NOT NULL THEN
    EXECUTE $idx$
      CREATE INDEX IF NOT EXISTS "Gallery_profile_public_sort"
      ON "Gallery"("profileId", "sortOrder")
      WHERE "deletedAt" IS NULL AND "status" = '1'
    $idx$;
  END IF;

  IF to_regclass('public."Video"') IS NOT NULL THEN
    EXECUTE $idx$
      CREATE INDEX IF NOT EXISTS "Video_profile_public_sort"
      ON "Video"("profileId", "sortOrder")
      WHERE "deletedAt" IS NULL AND "status" = '1'
    $idx$;
  END IF;
END $$;
